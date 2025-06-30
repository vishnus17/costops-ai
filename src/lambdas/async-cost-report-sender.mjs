import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";
import { generateCostReportPDF } from "../utils/pdf-utils.mjs";
import { askBedrock, buildCostSummaryPrompt } from "../utils/bedrock-utils.mjs";
import { getResourceLevelCosts } from "../utils/cost-explorer-utils.mjs";
import { DDBUtils } from "../utils/dynamodb-utils.mjs";

const region = 'ap-south-1';
const ddbUtils = new DDBUtils({
    region,
    reportsTable: process.env.REPORTS_DDB_TABLE,
    cacheTable: process.env.COST_EXPLORER_CACHE_TABLE || 'CostExplorerCache'
});

const s3 = new S3Client({region});
const ses = new SESClient({region});

const S3_BUCKET = process.env.REPORTS_BUCKET;
const CF_URL = process.env.CF_URL;

export const handler = async (event) => {
    for (const record of event.Records) {
        // Only process INSERT events
        if (record.eventName !== "INSERT") continue;
        const newImage = record.dynamodb.NewImage;
        if (!newImage) continue;
        const requestId = newImage.requestId?.S;
        const parsedJsonQueryStr = newImage.parsedJsonQuery?.S;
        const email = newImage.email?.S;
        const reportUrl = newImage.reportUrl?.S;
        const userCommand = newImage.userCommand?.S;
        if (!requestId || !parsedJsonQueryStr || !email) continue;
        if (reportUrl && reportUrl !== "PENDING") continue;

        let parsedQuery;
        try {
            parsedQuery = JSON.parse(parsedJsonQueryStr);
        } catch {
            continue;
        }

        console.log(`Parsed query for request ${requestId}:`, parsedQuery);

        // Determine date range
        let end, start;
        if (parsedQuery.startDate && parsedQuery.endDate) {
            start = new Date(parsedQuery.startDate);
            end = new Date(parsedQuery.endDate);
        } else if (parsedQuery.days) {
            const days = parsedQuery.days;
            end = new Date();
            start = new Date();
            start.setDate(end.getDate() - days);
        } else {
            end = new Date();
            start = new Date();
            start.setDate(end.getDate() - 14);
        }
        
        console.log(`Using start date: ${start.toISOString()}, end date: ${end.toISOString()}`);
        
        const granularity = "DAILY";
        const groupBy = [{ Type: "DIMENSION", Key: "RESOURCE_ID" }];
        
        // Generate cache key for storing the result after report generation
        const cacheKeyObj = {
            start: start.toISOString().split("T")[0],
            end: end.toISOString().split("T")[0],
            groupBy,
            granularity
        };
        const cacheKey = Buffer.from(JSON.stringify(cacheKeyObj)).toString('base64');
        
        let data;
        // Fetch cost data using utility function
        try {
            data = await getResourceLevelCosts({
                startDate: start.toISOString().split("T")[0],
                endDate: end.toISOString().split("T")[0],
                granularity,
                groupBy
            });
        } catch (err) {
            await ddbUtils.updateReportStatus(requestId, {
                reportUrl: "ERROR",
                costSummaryText: `Failed to generate report: ${err.message}`
            });
            continue;
        }
        
        // Proceed with report generation
        console.log(`Generating report for request ${requestId}`);

        const summaryPrompt = buildCostSummaryPrompt(data, userCommand, granularity);
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
        console.log(`PDF report generated for request ${requestId}: ${finalReportUrl}`);

        // Use DDBUtils for atomic cache write with summary
        await ddbUtils.setCache({ cacheKey, data, reportUrl: finalReportUrl, costSummaryText });

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
            await ses.send(new SendEmailCommand(emailParams));
        } catch (err) {
            console.error(`Failed to send email for request ${requestId}:`, err);
        }
        // Use DDBUtils to update report status
        await ddbUtils.updateReportStatus(requestId, {
            reportUrl: finalReportUrl,
            costSummaryText
        });
    }
    return { statusCode: 200 };
};
