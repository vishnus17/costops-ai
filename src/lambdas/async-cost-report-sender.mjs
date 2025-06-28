import { CostExplorerClient, GetCostAndUsageWithResourcesCommand } from "@aws-sdk/client-cost-explorer";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";
import { generateCostReportPDF } from "../utils/pdf-utils.mjs";
import { askBedrock, buildCostSummaryPrompt } from "../utils/bedrock-utils.mjs";
import { DDBUtils } from "../utils/dynamodb-utils.mjs";

const region = 'ap-south-1';
const ddbUtils = new DDBUtils({
    region,
    reportsTable: process.env.REPORTS_DDB_TABLE,
    cacheTable: process.env.COST_EXPLORER_CACHE_TABLE || 'CostExplorerCache'
});

const s3 = new S3Client({region});
const ses = new SESClient({region});
const ceClient = new CostExplorerClient({ region });

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
        
        // Cost Explorer parameters
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
        
        // --- DynamoDB-based caching for Cost Explorer API ---
        const cacheKeyObj = {
            start: start.toISOString().split("T")[0],
            end: end.toISOString().split("T")[0],
            groupBy,
            granularity
        };
        const cacheKey = Buffer.from(JSON.stringify(cacheKeyObj)).toString('base64');
        let data;
        let cachedReportUrl = null;
        // Use DDBUtils for cache
        const cacheResult = await ddbUtils.getCache({ cacheKey });
        if (cacheResult.hit) {
            data = cacheResult.data;
            cachedReportUrl = cacheResult.reportUrl;
        }
        // If cache miss, call Cost Explorer API
        if (!cacheResult.hit) {
            try {
                data = await ceClient.send(new GetCostAndUsageWithResourcesCommand(params));
                // Do NOT write to cache yet; wait until report is generated for atomic write
            } catch (err) {
                await ddbUtils.updateReportStatus(requestId, {
                    reportUrl: "ERROR",
                    costSummaryText: `Failed to generate report: ${err.message}`
                });
                continue;
            }
        }
        // If cache hit and reportUrl exists, skip report generation and just update DDB and notify
        if (cacheResult.hit && cachedReportUrl) {
            await ddbUtils.updateReportStatus(requestId, {
                reportUrl: cachedReportUrl,
                costSummaryText: "Report generated from cache."
            });
            // Send email notification here as well if needed
            const emailParams = {
                Destination: { ToAddresses: [email] },
                Message: {
                    Body: { Text: { Data: `Your AWS Resource-level Cost Report is ready.\n\nYou can download the PDF report here: ${cachedReportUrl}` } },
                    Subject: { Data: "Your AWS Resource-level Cost Report" },
                },
                Source: "cost-reports@learnmorecloud.com"
            };
            try {
                await ses.send(new SendEmailCommand(emailParams));
            } catch (err) {
                console.error(`Failed to send email for request ${requestId}:`, err);
            }
            continue;
        }
        // If cache miss, proceed with report generation
        console.log(`Generating report for request ${requestId}`);

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
        // Use DDBUtils for atomic cache write
        await ddbUtils.setCache({ cacheKey, data, reportUrl: finalReportUrl });

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
