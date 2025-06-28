// Lambda to generate scheduled cost/anomaly reports and save to S3
import { CostExplorerClient, GetCostAndUsageCommand } from "@aws-sdk/client-cost-explorer";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { askBedrock, buildCostSummaryPrompt } from "../utils/bedrock-utils.mjs";
import { generateCostReportPDF } from "../utils/pdf-utils.mjs";
import { DDBUtils } from "../utils/dynamodb-utils.mjs";

const s3 = new S3Client();
const region = 'ap-south-1';
const ddbUtils = new DDBUtils({
    region,
    reportsTable: process.env.REPORTS_DDB_TABLE,
    cacheTable: process.env.COST_EXPLORER_CACHE_TABLE || 'CostExplorerCache'
});
const CF_URL = process.env.CF_URL;

export const scheduledCostReportHandler = async (event) => {
    console.log("Received event:", JSON.stringify(event, null, 2));
    const ceClient = new CostExplorerClient({ region: "us-east-1" });

    // Prefer explicit startDate/endDate if provided, else fallback to days
    let start, end;
    if (event.startDate && event.endDate) {
        start = new Date(event.startDate);
        end = new Date(event.endDate);
    } else {
        const days = event.days || 7;
        end = new Date();
        end.setDate(end.getDate() + 1); // Make end exclusive, include today
        start = new Date();
        start.setDate(end.getDate() - days);
    }

    const groupBy = [{ Type: "DIMENSION", Key: "SERVICE" }];
    const granularity = "DAILY";
    const params = {
        TimePeriod: {
            Start: start.toISOString().split("T")[0],
            End: end.toISOString().split("T")[0],
        },
        Granularity: granularity,
        Metrics: ["UnblendedCost"],
        GroupBy: groupBy,
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
    // Use cache utility
    const cacheResult = await ddbUtils.getCache({ cacheKey });
    if (cacheResult.hit) {
        data = cacheResult.data;
        cachedReportUrl = cacheResult.reportUrl;
        if (cachedReportUrl) {
            console.log("Using cached report URL:", cachedReportUrl);
            return {
                statusCode: 200,
                headers: {
                    "Access-Control-Allow-Origin": "*",
                    "Access-Control-Allow-Methods": "OPTIONS,POST"
                },
                body: JSON.stringify({
                    message: `Cost Report (cached) ✅. You can view the report here: ${cachedReportUrl}`,
                })
            };
        }
    } else {
        data = await ceClient.send(new GetCostAndUsageCommand(params));
        console.log("Cost Explorer output:", JSON.stringify(data, null, 2));
    }

    // Prepare a summary prompt for Bedrock using utils
    const summaryPrompt = buildCostSummaryPrompt(data, granularity, groupBy);
    const responseText = await askBedrock(summaryPrompt);
    console.log("Cost report summary:", responseText);

    // Save the report to S3
    const reportKey = `scheduled-cost-reports/${Date.now()}.txt`;
    await s3.send(new PutObjectCommand({
        Bucket: S3_BUCKET,
        Key: reportKey,
        Body: responseText,
        ContentType: "text/plain",
    }));

    // Generate a PDF using pdf-utils
    const pdfBuffer = await generateCostReportPDF(responseText, data);

    // Save PDF to S3
    const pdfKey = `scheduled-cost-reports/${Date.now()}.pdf`;
    await s3.send(new PutObjectCommand({
        Bucket: S3_BUCKET,
        Key: pdfKey,
        Body: pdfBuffer,
        ContentType: "application/pdf",
    }));

    const reportUrl = `${CF_URL}/${pdfKey}`;
    console.log("Cost report PDF stored at:", reportUrl);

    // Use DDBUtils to set cache
    await ddbUtils.setCache({ cacheKey, data, reportUrl });

    return {
        statusCode: 200,
        headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "OPTIONS,POST"
        },
        body: JSON.stringify({
            message: `Cost Report generated successfully✅. You can view the report here: ${reportUrl}`,
        })
    };
}