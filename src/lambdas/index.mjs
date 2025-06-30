// ChatOps Lambda Functions: Cost + Incident AI Query Support via Amazon Bedrock (AWS SDK v3)

import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { EventBridgeClient, PutRuleCommand, PutTargetsCommand } from "@aws-sdk/client-eventbridge";
import { askBedrock, buildCostSummaryPrompt, buildUserRequestPrompt, buildMonthComparisonSummaryPrompt } from "../utils/bedrock-utils.mjs";
import { getCostAndUsageComparisons, prepareComparisonPeriods, getCostAndUsage } from "../utils/cost-explorer-utils.mjs";
import { generateCostReportPDF } from "../utils/pdf-utils.mjs";
import { DDBUtils } from "../utils/dynamodb-utils.mjs";
import { v4 as uuidv4 } from "uuid";

const region = process.env.AWS_REGION || 'ap-south-1';
const S3_BUCKET = process.env.REPORTS_BUCKET;
const CF_URL = process.env.CF_URL;
const REPORTS_DDB_TABLE = process.env.REPORTS_DDB_TABLE;
const COST_EXPLORER_CACHE_TABLE = process.env.COST_EXPLORER_CACHE_TABLE;
const SCHEDULED_COST_REPORT_LAMBDA_ARN = process.env.SCHEDULED_COST_REPORT_LAMBDA_ARN;

const requiredEnvVars = { S3_BUCKET, CF_URL, REPORTS_DDB_TABLE, SCHEDULED_COST_REPORT_LAMBDA_ARN };
for (const [key, value] of Object.entries(requiredEnvVars)) {
    if (!value) {
        throw new Error(`Missing required environment variable: ${key}`);
    }
}

const s3 = new S3Client({ region });
const eventBridge = new EventBridgeClient({ region });
const ddbUtils = new DDBUtils({
    region,
    reportsTable: REPORTS_DDB_TABLE,
    cacheTable: COST_EXPLORER_CACHE_TABLE
});

const REPORT_STATUS_PENDING = "PENDING";
const CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*", // Consider restricting this in production
    "Access-Control-Allow-Methods": "OPTIONS,POST",
    "Access-Control-Allow-Headers": "Content-Type,Authorization"
};

// --- Helper Functions ---

/**
 * Creates a standard API response object.
 * @param {number} statusCode - The HTTP status code.
 * @param {object} body - The response body.
 * @returns {object} The formatted API Gateway response.
 */
const createApiResponse = (statusCode, body) => ({
    statusCode,
    headers: CORS_HEADERS,
    body: JSON.stringify(body),
});

/**
 * Parses the JSON object from a Bedrock response string.
 * @param {string} bedrockResponse - The raw string response from Bedrock.
 * @returns {object} The parsed JSON object.
 * @throws {Error} If no valid JSON is found.
 */
const parseBedrockResponse = (bedrockResponse) => {
    const jsonMatch = bedrockResponse.match(/\{[\s\S]*\}/);
    if (jsonMatch && jsonMatch[0]) {
        try {
            return JSON.parse(jsonMatch[0]);
        } catch (e) {
            throw new Error(`Failed to parse JSON from Bedrock response: ${e.message}`);
        }
    }
    throw new Error("No valid JSON object found in the Bedrock response.");
};

/**
 * Determines the start and end dates for a cost report.
 * @param {object} parsedQuery - The query object from Bedrock.
 * @returns {{start: Date, end: Date}}
 */
const getDateRange = (parsedQuery) => {
    let start, end;
    const intent = (parsedQuery.intent || "").toLowerCase();

    if (parsedQuery.startDate && parsedQuery.endDate) {
        start = new Date(parsedQuery.startDate);
        end = new Date(parsedQuery.endDate);
    } else if (intent.includes("month")) {
        const now = new Date();
        start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
        end = new Date(now.getFullYear(), now.getMonth(), 1);
    } else {
        const days = parsedQuery.days || 7;
        end = new Date();
        start = new Date();
        start.setDate(end.getDate() - days);
    }
    return { start, end };
};

/**
 * Generates a deterministic cache key from request parameters.
 * @param {object} params - The parameters to include in the key.
 * @returns {string} A base64 encoded cache key.
 */
const generateCacheKey = (params) => {
    const keyString = JSON.stringify(params);
    return Buffer.from(keyString).toString('base64');
};


// Helper to create a recurring EventBridge rule for scheduled cost reports
async function createRecurringCostReportRule({ query, cronExpression }) {
    const ruleName = `ScheduledCostReport-${Date.now()}`;
    await eventBridge.send(new PutRuleCommand({
        Name: ruleName,
        ScheduleExpression: cronExpression, // e.g., 'cron(0 8 * * ? *)' for 8am UTC daily
        State: "ENABLED",
    }));
    // Set the Lambda as the target
    await eventBridge.send(new PutTargetsCommand({
        Rule: ruleName,
        Targets: [
            {
                Id: `ScheduledCostReportTarget-${Date.now()}`,
                Arn: SCHEDULED_COST_REPORT_LAMBDA_ARN,
                Input: JSON.stringify({
                    isScheduled: true,
                    parsedQuery: query
                })
            }
        ]
    }));
    return ruleName;
}

/**
 * Saves a report entry to DynamoDB.
 * @param {Object} params
 * @param {string} params.requestId - Unique request ID.
 * @param {string} params.userCommand - Original user command.
 * @param {Object} params.parsedJsonQuery - Parsed query from Bedrock.
 * @param {string} params.reportUrl - S3 URL or status.
 * @param {string} params.costSummaryText - Cost summary text or status.
 * @param {string} [params.email] - User email (optional).
 * @returns {Promise<any>} DynamoDB operation result.
 */
async function saveReportToDynamo({ requestId, userCommand, parsedJsonQuery, reportUrl, costSummaryText, email }) {
    return ddbUtils.saveReport({ requestId, userCommand, parsedJsonQuery, reportUrl, costSummaryText, email });
}

/**
 * Helper to detect if the parsed query is a month-to-month comparison request.
 * @param {Object} parsedQuery
 * @returns {boolean}
 */
function isMonthComparisonRequest(parsedQuery) {
    if (!parsedQuery || typeof parsedQuery !== 'object') return false;
    const intent = (parsedQuery.intent || '').toLowerCase();
    return intent.includes('compare') && intent.includes('month');
}

/**
 * Main cost report handler for all report types, including month-to-month comparison.
 * @param {Object} parsedQuery - Parsed query from Bedrock.
 * @param {string|null} userEmail - User's email address.
 * @param {string|null} requestId - Request ID for tracking.
 * @param {string} userCommand - Original user command.
 * @returns {Promise<Object>} API response object.
 */
async function costReportHandler(parsedQuery, userEmail = null, requestId = null, userCommand = "") {
    const intent = (parsedQuery.intent || "").toLowerCase();
    requestId = requestId || uuidv4();

    // --- Month-to-month cost comparison feature ---
    if (isMonthComparisonRequest(parsedQuery)) {
        const { period1, period2 } = parsedQuery;
        if (!period1 || !period2 || !period1.start || !period1.end || !period2.start || !period2.end) {
            return createApiResponse(400, { message: "Invalid comparison periods provided.", requestId });
        }
        
        const { baseline, comparison } = prepareComparisonPeriods(period1, period2);
        
        // Generate cache key for comparison report
        const comparisonCacheKeyParams = {
            type: "comparison",
            baseline: baseline,
            comparison: comparison,
            metricForComparison: "UnblendedCost",
            granularity: "MONTHLY",
            groupBy: [{ Type: "DIMENSION", Key: "SERVICE" }]
        };
        
        // Add specialRequirements to cache key if present
        if (parsedQuery.specialRequirements) {
            comparisonCacheKeyParams.specialRequirements = parsedQuery.specialRequirements;
        }
        
        const cacheKey = generateCacheKey(comparisonCacheKeyParams);
        
        // Check cache first
        const cacheResult = await ddbUtils.getCache({ cacheKey });
        if (cacheResult.hit && cacheResult.reportUrl) {
            console.log("Using cached comparison report URL:", cacheResult.reportUrl);
            return createApiResponse(200, {
                message: `Please view the comparison report here: ${cacheResult.reportUrl}`,
                reportUrl: cacheResult.reportUrl,
                summary: cacheResult.summary || "",
                requestId
            });
        }
        
        let comparisonData = cacheResult.data;
        if (!cacheResult.hit) {
            try {
                comparisonData = await getCostAndUsageComparisons({
                    baselineTimePeriod: baseline,
                    comparisonTimePeriod: comparison,
                    metricForComparison: "UnblendedCost",
                    granularity: "MONTHLY",
                    groupBy: [{ Type: "DIMENSION", Key: "SERVICE" }]
                });
                console.log(JSON.stringify({ level: 'info', msg: 'Fetched Cost Comparison result', cacheKey }));
            } catch (err) {
                console.error(JSON.stringify({ level: 'error', msg: 'Cost Comparison fetch failed', cacheKey, error: err.message }));
                return createApiResponse(500, { message: `Failed to generate comparison report: ${err.message}` , requestId });
            }
        }
        
        // Build a summary prompt for Bedrock for comparison (moved to bedrock-utils)
        const summaryPrompt = buildMonthComparisonSummaryPrompt(period1, period2, comparisonData);
        const bedrockCostResponse = await askBedrock(summaryPrompt);
        const costSummaryText = bedrockCostResponse.trim();
        
        // Save as PDF and S3 as usual
        const reportId = uuidv4();
        const pdfKey = `cost-reports/${reportId}-comparison.pdf`;
        const pdfBuffer = await generateCostReportPDF(costSummaryText, comparisonData);
        await s3.send(new PutObjectCommand({
            Bucket: S3_BUCKET,
            Key: pdfKey,
            Body: pdfBuffer,
            ContentType: "application/pdf",
        }));
        const reportUrl = `${CF_URL}/${pdfKey}`;
        
        // Update cache with new data, report URL, and summary
        await ddbUtils.setCache({ cacheKey, data: comparisonData, reportUrl, costSummaryText });
        
        return createApiResponse(200, {
            message: `Cost Comparison Report generated successfully✅. You can view the report here: ${reportUrl}`,
            reportUrl,
            summary: costSummaryText,
            requestId
        });
    }

    // For resource-level breakdown, which can be long-running, we save state and return immediately.
    if (intent.includes("resource")) {
        // First check cache for existing resource-level report
        const { start, end } = getDateRange(parsedQuery);
        const granularity = "DAILY";
        const groupBy = [{ Type: "DIMENSION", Key: "RESOURCE_ID" }];

        const resourceCacheKeyParams = {
            start: start.toISOString().split("T")[0],
            end: end.toISOString().split("T")[0],
            groupBy,
            granularity
        };
        
        // Add specialRequirements to cache key if present
        if (parsedQuery.specialRequirements) {
            resourceCacheKeyParams.specialRequirements = parsedQuery.specialRequirements;
        }
        
        const resourceCacheKey = generateCacheKey(resourceCacheKeyParams);

        // Check cache first for resource-level reports
        const resourceCacheResult = await ddbUtils.getCache({ cacheKey: resourceCacheKey });
        if (resourceCacheResult.hit && resourceCacheResult.reportUrl) {
            return createApiResponse(200, {
                message: `Please view the cached resource-level report here: ${resourceCacheResult.reportUrl}`,
                reportUrl: resourceCacheResult.reportUrl,
                summary: resourceCacheResult.summary || "",
                requestId
            });
        }

        // If no cache hit, proceed with async processing
        await saveReportToDynamo({
            requestId,
            userCommand,
            parsedJsonQuery: parsedQuery,
            reportUrl: REPORT_STATUS_PENDING,
            costSummaryText: REPORT_STATUS_PENDING,
            email: userEmail
        });

        if (!userEmail) {
            return createApiResponse(202, {
                message: `Your cost report with resource-level breakdown is being generated. Please provide your email address to receive the report when it's ready.`,
                needEmail: true,
                requestId
            });
        }
        return createApiResponse(200, {
            message: `Thank you! The resource-level cost report will be sent to ${userEmail} when ready. Your Request ID is ${requestId}.`,
            requestId
        });
    }

    // --- For standard, non-resource-level reports ---
    const { start, end } = getDateRange(parsedQuery);
    const granularity = intent.includes("month") ? "MONTHLY" : "DAILY";
    const groupBy = [{ Type: "DIMENSION", Key: "SERVICE" }];

    const cacheKeyParams = {
        start: start.toISOString().split("T")[0],
        end: end.toISOString().split("T")[0],
        groupBy,
        granularity
    };
    
    // Add specialRequirements to cache key if present
    if (parsedQuery.specialRequirements) {
        cacheKeyParams.specialRequirements = parsedQuery.specialRequirements;
    }
    
    const cacheKey = generateCacheKey(cacheKeyParams);

    // Check cache first
    const cacheResult = await ddbUtils.getCache({ cacheKey });
    if (cacheResult.hit && cacheResult.reportUrl) {
        console.log("Using cached report URL:", cacheResult.reportUrl);
        return createApiResponse(200, {
            message: `Please view the report here: ${cacheResult.reportUrl}`,
            reportUrl: cacheResult.reportUrl,
            summary: cacheResult.summary || "",
            requestId
        });
    }

    let data = cacheResult.data;
    if (!cacheResult.hit) {
        try {
            data = await getCostAndUsage({
                startDate: start.toISOString().split("T")[0],
                endDate: end.toISOString().split("T")[0],
                granularity,
                groupBy
            });
            console.log(JSON.stringify({ level: 'info', msg: 'Fetched Cost Explorer result', cacheKey }));
        } catch (err) {
            console.error(JSON.stringify({ level: 'error', msg: 'Cost Explorer fetch failed', cacheKey, error: err.message }));
            throw err;
        }
    }

    // Generate summary and reports
    const summaryPrompt = buildCostSummaryPrompt(data, userCommand, granularity);
    const bedrockCostResponse = await askBedrock(summaryPrompt);
    const costSummaryText = bedrockCostResponse.trim();
    console.log("Bedrock cost summary response:", bedrockCostResponse);

    const reportId = uuidv4();
    const pdfKey = `cost-reports/${reportId}.pdf`;
    const textKey = `cost-reports/${reportId}.txt`;

    // Generate PDF and upload both reports to S3 in parallel
    const pdfBuffer = await generateCostReportPDF(costSummaryText, data);
    await Promise.all([
        s3.send(new PutObjectCommand({ Bucket: S3_BUCKET, Key: pdfKey, Body: pdfBuffer, ContentType: "application/pdf" })),
        s3.send(new PutObjectCommand({ Bucket: S3_BUCKET, Key: textKey, Body: costSummaryText, ContentType: "text/plain" }))
    ]);

    const reportUrl = `${CF_URL}/${pdfKey}`;
    console.log("Cost report generated:", reportUrl);

    // Update cache with new data and report URL
    await ddbUtils.setCache({ cacheKey, data, reportUrl, costSummaryText });

    return createApiResponse(200, {
        message: `Cost Report generated successfully✅. You can view the report here: ${reportUrl}`,
        reportUrl,
        summary: costSummaryText,
        requestId
    });
}

/**
 * Validates an email address.
 * @param {string} email
 * @returns {boolean}
 */
function validateEmail(email) {
    return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email);
}

/**
 * Intent handler mapping for Bedrock output.
 * @type {Object<string, function>}
 */
const INTENT_HANDLERS = {
    scheduled: handleScheduledCostReport,
    resource: (query, email, requestId, command) => costReportHandler(query, email, requestId, command),
    monthly: (query, email, requestId, command) => costReportHandler(query, email, requestId, command),
    daily: (query, email, requestId, command) => costReportHandler(query, email, requestId, command),
};

/**
 * Identifies the intent and handler from a parsed Bedrock query.
 * @param {Object} parsedQuery
 * @returns {{type: string, handler: function|null, confidence: string}}
 */
function identifyIntent(parsedQuery) {
    const intent = (parsedQuery.intent || "").toLowerCase();
    const handler = INTENT_HANDLERS[intent];

    if (handler) {
        return {
            type: intent,
            handler: handler,
            confidence: 'high'
        };
    }
    
    // Fallback for more complex intents
    if (intent.includes('schedule') || intent.includes('recurring')) {
        return { type: 'scheduled', handler: INTENT_HANDLERS.scheduled, confidence: 'medium' };
    }
    if (intent.includes('resource')) {
        return { type: 'resource', handler: INTENT_HANDLERS.resource, confidence: 'medium' };
    }
    if (intent.includes('month')) {
        return { type: 'monthly', handler: INTENT_HANDLERS.monthly, confidence: 'medium' };
    }

    return {
        type: 'UNKNOWN',
        handler: null,
        confidence: 'none'
    };
}

/**
 * Handler for scheduled cost report creation.
 * @param {Object} parsedQuery
 * @returns {Promise<Object>} API response object.
 */
async function handleScheduledCostReport(parsedQuery) {
    if (!parsedQuery.cronExpression) {
        throw new Error("Cron expression is required for scheduled reports");
    }

    const ruleName = await createRecurringCostReportRule({
        query: parsedQuery,
        cronExpression: parsedQuery.cronExpression,
    });

    return createApiResponse(200, {
        message: `✅ Scheduled cost report successfully with rule '${ruleName}'. It will run according to the specified cron expression: ${parsedQuery.cronExpression}.`
    });
}

/**
 * Validates parsed query parameters for each intent type.
 * @param {Object} parsedQuery
 * @param {string} intentType
 */
function validateParsedQuery(parsedQuery, intentType) {
    const validations = {
        SCHEDULED_COST_REPORT: () => {
            if (!parsedQuery.cronExpression) {
                throw new Error("Cron expression is required for scheduled reports");
            }
        },
        RESOURCE_BREAKDOWN: () => {
            // Add specific validations for resource breakdown
            if (parsedQuery.days && (parsedQuery.days < 1 || parsedQuery.days > 14)) {
                throw new Error("Days must be between 1 and 14");
            }
        },
        BILLING_REPORT: () => {
            // Add specific validations for billing reports
            if (parsedQuery.startDate && parsedQuery.endDate) {
                const start = new Date(parsedQuery.startDate);
                const end = new Date(parsedQuery.endDate);
                if (start > end) {
                    throw new Error("Start date cannot be after end date");
                }
            }
        },
    };

    const validator = validations[intentType];
    if (validator) {
        validator();
    }
}

/**
 * Lambda main entry point for API Gateway and EventBridge events.
 * @param {Object} event - Lambda event object.
 * @returns {Promise<Object>} API Gateway response.
 */
export const mainHandler = async (event) => {
    try {
        if (!event.body) {
            return createApiResponse(400, { message: '❌ Missing request body.' });
        }
        const body = JSON.parse(event.body);
        const { message: userCommand, requestId, email } = body;
        const userEmail = email || event.requestContext?.authorizer?.claims?.email;

        // Input validation
        if (!userCommand) {
            return createApiResponse(400, { message: '❌ Missing message in request body.' });
        }
        if (userEmail && !validateEmail(userEmail)) {
            return createApiResponse(400, { message: '❌ Invalid email address.' });
        }

        // Build the user request prompt for Bedrock
        const bedrockPrompt = buildUserRequestPrompt(userCommand);
        const bedrockUserCommandResponse = await askBedrock(bedrockPrompt);
        const parsedJsonQuery = parseBedrockResponse(bedrockUserCommandResponse);
        
        console.log("Parsed JSON query:", parsedJsonQuery);

        // Identify intent and execute the appropriate handler
        const intentResult = identifyIntent(parsedJsonQuery);
        if (intentResult.type === 'UNKNOWN') {
            return createApiResponse(400, {
                message: "Sorry, I couldn't understand your request. Please try a cost or incident query, or ask to schedule a cost report.",
            });
        }

        validateParsedQuery(parsedJsonQuery, intentResult.type);

        return await intentResult.handler(parsedJsonQuery, userEmail, requestId, userCommand);

    } catch (error) {
        console.error(JSON.stringify({ 
            level: 'error', 
            msg: 'mainHandler error', 
            error: error.message,
            stack: error.stack
        }));

        const isValidationError = error.message.includes('validation') || error instanceof SyntaxError || error.message.includes('Bedrock');
        const statusCode = isValidationError ? 400 : 500;

        return createApiResponse(statusCode, {
            message: `❌ An error occurred: ${error.message}`,
        });
    }
};
