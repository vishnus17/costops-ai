// Lambda to generate scheduled cost/anomaly reports and save to S3
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { askBedrock, buildCostSummaryPrompt, buildUserRequestPrompt } from "../utils/bedrock-utils.mjs";
import { getCostAndUsage, getResourceLevelCosts } from "../utils/cost-explorer-utils.mjs";
import { generateCostReportPDF } from "../utils/pdf-utils.mjs";
import { DDBUtils } from "../utils/dynamodb-utils.mjs";
import { v4 as uuidv4 } from "uuid";

const region = process.env.AWS_REGION || 'ap-south-1';
const S3_BUCKET = process.env.REPORTS_BUCKET;
const CF_URL = process.env.CF_URL;
const REPORTS_DDB_TABLE = process.env.REPORTS_DDB_TABLE;
const COST_EXPLORER_CACHE_TABLE = process.env.COST_EXPLORER_CACHE_TABLE || 'CostExplorerCache';

const requiredEnvVars = { S3_BUCKET, CF_URL, REPORTS_DDB_TABLE };
for (const [key, value] of Object.entries(requiredEnvVars)) {
    if (!value) {
        throw new Error(`Missing required environment variable: ${key}`);
    }
}

const s3 = new S3Client({ region });
const ddbUtils = new DDBUtils({
    region,
    reportsTable: REPORTS_DDB_TABLE,
    cacheTable: COST_EXPLORER_CACHE_TABLE
});

const CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "OPTIONS,POST",
    "Access-Control-Allow-Headers": "Content-Type,Authorization"
};

/**
 * Helper to create a standard API response.
 * @param {number} statusCode
 * @param {object} body
 * @returns {object}
 */
const createApiResponse = (statusCode, body) => ({
    statusCode,
    headers: CORS_HEADERS,
    body: JSON.stringify(body),
});

/**
 * Lambda handler for scheduled cost report generation.
 * @param {Object} event - Lambda event object.
 * @param {string} [event.startDate] - Optional ISO start date.
 * @param {string} [event.endDate] - Optional ISO end date.
 * @param {number} [event.days] - Optional number of days for the report window.
 * @returns {Promise<Object>} API Gateway response object.
 */
export const scheduledCostReportHandler = async (event) => {
    try {
        console.log("Received event:", JSON.stringify(event, null, 2));

        // Prefer explicit startDate/endDate if provided, else fallback to days
        let start, end;
        if (event.startDate && event.endDate) {
            start = new Date(event.startDate);
            end = new Date(event.endDate);
        } else {
            const days = event.days || 7;
            end = new Date();
            start = new Date();
            start.setDate(end.getDate() - days);
        }

        const granularity = event.granularity || "DAILY"; // Default to DAILY if not specified

        const groupBy = [{ Type: "DIMENSION", Key: "SERVICE" }];
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
                return createApiResponse(200, {
                    message: `Please view the cost report here: ${cachedReportUrl}`,
                });
            }
        } else {
            data = await getCostAndUsage({
                startDate: start.toISOString().split("T")[0],
                endDate: end.toISOString().split("T")[0],
                granularity,
                groupBy
            });
            console.log("Cost Explorer output:", JSON.stringify(data, null, 2));
        }

        // Prepare a summary prompt for Bedrock using utils
        const summaryPrompt = buildCostSummaryPrompt(data, granularity, groupBy);
        const responseText = await askBedrock(summaryPrompt);
        console.log("Cost report summary:", responseText);

        // Save the report to S3
        const reportId = uuidv4();
        const reportKey = `scheduled-cost-reports/${reportId}.txt`;
        await s3.send(new PutObjectCommand({
            Bucket: S3_BUCKET,
            Key: reportKey,
            Body: responseText,
            ContentType: "text/plain",
        }));

        // Generate a PDF using pdf-utils
        const pdfBuffer = await generateCostReportPDF(responseText, data);

        // Save PDF to S3
        const pdfKey = `scheduled-cost-reports/${reportId}.pdf`;
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

        return createApiResponse(200, {
            message: `Cost Report generated successfully✅. You can view the report here: ${reportUrl}`,
        });
    } catch (error) {
        console.error(JSON.stringify({
            level: 'error',
            msg: 'scheduledCostReportHandler error',
            error: error.message,
            stack: error.stack
        }));
        return createApiResponse(500, {
            message: `❌ An error occurred: ${error.message}`,
        });
    }
};