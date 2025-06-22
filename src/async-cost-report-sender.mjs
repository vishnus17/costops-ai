import { DynamoDBClient, UpdateItemCommand } from "@aws-sdk/client-dynamodb";
import { CostExplorerClient, GetCostAndUsageWithResourcesCommand } from "@aws-sdk/client-cost-explorer";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";
import { generateCostReportPDF } from "./pdf-utils.mjs";
import { askBedrock, buildCostSummaryPrompt } from "./bedrock-utils.mjs";

const region = 'ap-south-1';

const dynamo = new DynamoDBClient({region});
const s3 = new S3Client({region});
const ses = new SESClient({region});

const DDB_TABLE = process.env.REPORTS_DDB_TABLE;
const S3_BUCKET = process.env.REPORTS_BUCKET;
const CF_URL = process.env.CF_URL;

export const handler = async (event) => {
    for (const record of event.Records) {
        console.log(`Processing record: ${JSON.stringify(record)}`);
        // Only process INSERT events
        if (record.eventName !== "INSERT") continue;
        const newImage = record.dynamodb.NewImage;
        if (!newImage) continue;
        const requestId = newImage.requestId?.S;
        const parsedJsonQueryStr = newImage.parsedJsonQuery?.S;
        const email = newImage.email?.S;
        const reportUrl = newImage.reportUrl?.S;
        if (!requestId || !parsedJsonQueryStr || !email) continue;
        if (reportUrl && reportUrl !== "PENDING") continue; // Already processed

        let parsedQuery;
        try {
            parsedQuery = JSON.parse(parsedJsonQueryStr);
        } catch {
            continue;
        }

        console.log(`Parsed query for request ${requestId}:`, parsedQuery);

        // Build Cost Explorer params from parsedQuery
        let groupBy = [{ Type: "DIMENSION", Key: "RESOURCE_ID" }];
        let granularity = "DAILY";
        let end, start;
        if (parsedQuery.startDate && parsedQuery.endDate) {
            start = new Date(parsedQuery.startDate);
            end = new Date(parsedQuery.endDate);
        } else {
            end = new Date();
            start = new Date();
            start.setDate(end.getDate() - 14);
        }
        const params = {
            TimePeriod: {
                Start: start.toISOString().split("T")[0],
                End: end.toISOString().split("T")[0],
            },
            Granularity: granularity,
            Metrics: ["UnblendedCost"],
            GroupBy: groupBy,
            Filter: {
                Not: {
                    Dimensions: {
                        Key: "RECORD_TYPE",
                        Values: ["Credit", "Refund"]
                    }
                }
            }
        };
        const ceClient = new CostExplorerClient({ region });
        let data;
        try {
            data = await ceClient.send(new GetCostAndUsageWithResourcesCommand(params));
        } catch (err) {
            await dynamo.send(new UpdateItemCommand({
                TableName: DDB_TABLE,
                Key: { requestId: { S: requestId } },
                UpdateExpression: "SET reportUrl = :u, costSummaryText = :t",
                ExpressionAttributeValues: {
                    ":u": { S: "ERROR" },
                    ":t": { S: `Failed to generate report: ${err.message}` }
                }
            }));
            continue;
        }
        // Summarize and generate PDF
        const summaryPrompt = buildCostSummaryPrompt(data, granularity, groupBy);
        const bedrockCostResponse = await askBedrock(summaryPrompt);
        const costSummaryText = bedrockCostResponse.trim();
        const pdfBuffer = await generateCostReportPDF(costSummaryText, data);
        const pdfKey = `cost-reports/${requestId}.pdf`;
        await s3.send(new PutObjectCommand({
            Bucket: S3_BUCKET,
            Key: pdfKey,
            Body: pdfBuffer,
            ContentType: "application/pdf",
        }));
        const finalReportUrl = `${CF_URL}/${pdfKey}`;

        console.log(`Generated report for request ${requestId}: ${finalReportUrl}`);
        // Send email
        const emailParams = {
            Destination: { ToAddresses: [email] },
            Message: {
                Body: { Text: { Data: `Your AWS Resource-level Cost Report is ready.\n\nYou can download the PDF report here: ${finalReportUrl}\n\nSummary:\n${costSummaryText}` } },
                Subject: { Data: "Your AWS Resource-level Cost Report" },
            },
            Source: "cost-reports@learnmorecloud.com"
        };
        try {
            const sesResponse = await ses.send(new SendEmailCommand(emailParams));
            console.log(`Email logs: ${sesResponse}`);
        } catch (err) {
            console.error(`Failed to send email for request ${requestId}:`, err);
        }
        // Update DynamoDB with report URL and summary
        await dynamo.send(new UpdateItemCommand({
            TableName: DDB_TABLE,
            Key: { requestId: { S: requestId } },
            UpdateExpression: "SET reportUrl = :u, costSummaryText = :t",
            ExpressionAttributeValues: {
                ":u": { S: finalReportUrl },
                ":t": { S: costSummaryText }
            }
        }));
    }
    return { statusCode: 200 };
};
