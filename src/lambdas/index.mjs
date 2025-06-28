// ChatOps Lambda Functions: Cost + Incident AI Query Support via Amazon Bedrock (AWS SDK v3)

import { CostExplorerClient, GetCostAndUsageCommand } from "@aws-sdk/client-cost-explorer";
import { SSMIncidentsClient, ListIncidentRecordsCommand } from "@aws-sdk/client-ssm-incidents";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { EventBridgeClient, PutRuleCommand, PutTargetsCommand } from "@aws-sdk/client-eventbridge";
import { askBedrock, buildCostSummaryPrompt, buildUserRequestPrompt } from "../utils/bedrock-utils.mjs";
import { generateCostReportPDF } from "../utils/pdf-utils.mjs";
import { DDBUtils } from "../utils/dynamodb-utils.mjs";
import { v4 as uuidv4 } from "uuid";

const region = 'ap-south-1';
const s3 = new S3Client({region});
const ddbUtils = new DDBUtils({
    region,
    reportsTable: process.env.REPORTS_DDB_TABLE,
    cacheTable: process.env.COST_EXPLORER_CACHE_TABLE || 'CostExplorerCache'
});
const S3_BUCKET = process.env.REPORTS_BUCKET || "lambda-cost-reports";
const CF_URL = process.env.CF_URL;


// Helper to create a recurring EventBridge rule for scheduled cost reports
async function createRecurringCostReportRule({ query, cronExpression }) {
    const eventBridge = new EventBridgeClient();
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
                Arn: process.env.SCHEDULED_COST_REPORT_LAMBDA_ARN,
                Input: JSON.stringify({ query })
            }
        ]
    }));
}

async function saveReportToDynamo({ requestId, userCommand, parsedJsonQuery, reportUrl, costSummaryText, email }) {
    return ddbUtils.saveReport({ requestId, userCommand, parsedJsonQuery, reportUrl, costSummaryText, email });
}

async function getReportFromDynamo(requestId) {
    return ddbUtils.getReport(requestId);
}

async function updateEmailInDynamo(requestId, email) {
    return ddbUtils.updateEmail(requestId, email);
}

async function costReportHandler(parsedQuery, userEmail = null, requestId = null, userCommand = "") {
    const intent = (parsedQuery.intent || "").toLowerCase();
    let isResourceLevel = intent.includes("resource level breakdown");
    requestId = requestId || uuidv4();

    // For resource-level breakdown, check cache first
    if (isResourceLevel) {
        // Build cache key for resource-level breakdown
        let groupBy = [{ Type: "DIMENSION", Key: "RESOURCE_ID" }];
        let granularity = "DAILY";
        let start, end;
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
        const cacheKeyObj = {
            start: start.toISOString().split("T")[0],
            end: end.toISOString().split("T")[0],
            groupBy,
            granularity
        };
        const cacheKey = Buffer.from(JSON.stringify(cacheKeyObj)).toString('base64');
        const cacheResult = await ddbUtils.getCache({ cacheKey });
        if (cacheResult.hit && cacheResult.reportUrl) {
            return {
                statusCode: 200,
                headers: {
                    "Access-Control-Allow-Origin": "*",
                    "Access-Control-Allow-Methods": "OPTIONS,POST"
                },
                body: JSON.stringify({
                    message: `Resource-level Cost Report (cached) ✅. You can view the report here: ${cacheResult.reportUrl}`,
                    requestId
                })
            };
        }
        // If not cached, proceed as before
        await saveReportToDynamo({
            requestId,
            userCommand,
            parsedJsonQuery: parsedQuery,
            reportUrl: "PENDING",
            costSummaryText: "PENDING",
            email: userEmail
        });
        if (!userEmail) {
            return {
                statusCode: 202,
                headers: {
                    "Access-Control-Allow-Origin": "*",
                    "Access-Control-Allow-Methods": "OPTIONS,POST"
                },
                body: JSON.stringify({
                    message: `Your cost report with resource-level breakdown is being generated. Please provide your email address to receive the report when it's ready.`,
                    needEmail: true,
                    requestId
                })
            };
        } else {
            return {
                statusCode: 200,
                headers: {
                    "Access-Control-Allow-Origin": "*",
                    "Access-Control-Allow-Methods": "OPTIONS,POST"
                },
                body: JSON.stringify({
                    message: `Thank you! The resource-level cost report will be sent to ${userEmail} when ready.`,
                    requestId
                })
            };
        }
    }

    const ceClient = new CostExplorerClient({ region: region });
    let groupBy = [{ Type: "DIMENSION", Key: "SERVICE" }];
    let granularity = "DAILY";
    let start, end;

    // Use explicit start and end dates if provided
    if (parsedQuery.startDate && parsedQuery.endDate) {
        start = new Date(parsedQuery.startDate);
        end = new Date(parsedQuery.endDate);
    // Monthly cost statement (fallback if no explicit dates)
    } else if (intent.includes("month")) {
        granularity = "MONTHLY";
        const now = new Date();
        start = new Date(now.getFullYear(), now.getMonth() -1 , 1);
        end = new Date(now.getFullYear(), now.getMonth(), 1);
    } else {
        const days = parsedQuery.days || 7;
        end = new Date();
        start = new Date();
        start.setDate(end.getDate() - days);
    }

    // --- DynamoDB-based caching for Cost Explorer API ---
    const cacheKeyObj = {
        start: start.toISOString().split("T")[0],
        end: end.toISOString().split("T")[0],
        groupBy,
        granularity
    };
    const cacheKey = Buffer.from(JSON.stringify(cacheKeyObj)).toString('base64');
    let data;
    let cacheHit = false;
    // Use DDBUtils for cache
    const cacheResult = await ddbUtils.getCache({ cacheKey });
    if (cacheResult.hit) {
        data = cacheResult.data;
        if (cacheResult.reportUrl) {
            const cachedReportUrl = cacheResult.reportUrl;
            console.log("Using cached report URL:", cachedReportUrl);
            return { 
                statusCode: 200,
                headers: {
                    "Access-Control-Allow-Origin": "*",
                    "Access-Control-Allow-Methods": "OPTIONS,POST"
                },
                body: JSON.stringify({
                    message: `Cost Report (cached) ✅. You can view the report here: ${cachedReportUrl}`,
                    requestId
                })
            };
        }
        cacheHit = true;
    }
    if (!cacheHit) {
        try {
            data = await ceClient.send(new GetCostAndUsageCommand({
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
            }));
            console.log(JSON.stringify({ level: 'info', msg: 'Fetched Cost Explorer result', cacheKey }));
        } catch (err) {
            console.error(JSON.stringify({ level: 'error', msg: 'Cost Explorer fetch/cache failed', cacheKey, error: err.message }));
            throw err;
        }
    }

    // Prepare Bedrock prompt based on intent
    const summaryPrompt = buildCostSummaryPrompt(data, intent, granularity, groupBy);

    // Ask Bedrock to summarize the cost data
    const bedrockCostResponse = await askBedrock(summaryPrompt);
    const costSummaryText = bedrockCostResponse.trim();
    console.log("Bedrock cost summary response:", bedrockCostResponse);
    
    // Save the report to S3 (text)
    const reportKey = `cost-reports/${Date.now()}.txt`;
    await s3.send(new PutObjectCommand({
        Bucket: S3_BUCKET,
        Key: reportKey,
        Body: costSummaryText,
        ContentType: "text/plain",
    }));

    // Generate PDF using utility
    const pdfKey = `cost-reports/${Date.now()}.pdf`;
    const pdfBuffer = await generateCostReportPDF(costSummaryText, data);

    await s3.send(new PutObjectCommand({
        Bucket: S3_BUCKET,
        Key: pdfKey,
        Body: pdfBuffer,
        ContentType: "application/pdf",
    }));

    const reportUrl = `${CF_URL}/${pdfKey}`;
    console.log("Cost report generated:", reportUrl);

    // Now update the DynamoDB cache with the report URL
    await ddbUtils.setCache({ cacheKey, data, reportUrl });

    return { 
        statusCode: 200,
        headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "OPTIONS,POST"
        },
        body: JSON.stringify({
            message: `Cost Report generated successfully✅. You can view the report here: ${reportUrl}`,
            requestId
        })
    };
}

async function incidentStatusHandler(parsedQuery) {
    const days = parsedQuery.days || 7;
    const ssmIncidents = new SSMIncidentsClient({
        region: region
    });

    try {
        const response = await ssmIncidents.send(
            new ListIncidentRecordsCommand({ maxResults: 50 })
        );
        console.log("SSM Incidents output:", JSON.stringify(response, null, 2));
        const now = new Date();
        const cutoff = new Date(now.setDate(now.getDate() - days));

        const filtered = (response.incidentRecordSummaries || []).filter((inc) => {
            const createdTime = new Date(inc.creationTime);
            return createdTime >= cutoff;
        });

        let incidentsMessage;
        if (filtered.length === 0) {
            incidentsMessage = `✅ No incidents found in the last ${days} day(s).`;
        } else {
            const summaries = filtered
                .map(
                    (rec) =>
                        `• *${rec.arn.split("/").pop()}* - ${rec.status} - ${rec.impact}`
                )
                .join("\n");
            incidentsMessage = `⚠️ Incidents in the last ${days} day(s):\n\n${summaries}`;
        }

        return {
            statusCode: 200,
            headers: {
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Methods": "OPTIONS,POST"
            },
            body: JSON.stringify({
                message: incidentsMessage,
            }),
        };
    } catch (err) {
        console.error("SSM Incidents error:", err);
        return {
            statusCode: 500,
            headers: {
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Methods": "OPTIONS,POST"
            },
            body: JSON.stringify({
                message: `❌ Failed to fetch incidents: ${err.message}`,
            }),
        };
    }
}

// Input validation helper
function validateEmail(email) {
    return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email);
}

// Main handler that dynamically invokes the necessary function
export const mainHandler = async (event) => {
    try {
        const body = JSON.parse(event.body);
        const userCommand = body.message;
        const userEmail = body.email || null;
        const requestId = body.requestId || null;

        // Input validation
        if (userEmail && !validateEmail(userEmail)) {
            return {
                statusCode: 400,
                body: JSON.stringify({ message: '❌ Invalid email address.' })
            };
        }

        // Build the user request prompt for Bedrock
        const bedrockPrompt = buildUserRequestPrompt(userCommand);
        console.log("User prompt for Bedrock:", bedrockPrompt);

        // Perform Bedrock request
        const bedrockUserCommandResponse = await askBedrock(bedrockPrompt);

        // Parse the Bedrock response to extract the JSON query
        let parsedJsonQuery;
        const jsonMatch = bedrockUserCommandResponse.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            parsedJsonQuery = JSON.parse(jsonMatch[0]);
        } else {
            throw new Error("No JSON object found in Bedrock output");
        }
        console.log("Parsed JSON query:", parsedJsonQuery);
        const intent = (parsedJsonQuery.intent || "").toLowerCase();
        
        if (intent.includes("scheduled cost report")) {
            await createRecurringCostReportRule({
                query: parsedJsonQuery,
                cronExpression: parsedJsonQuery.cronExpression,
            });
            return { 
                statusCode: 200,
                headers: {
                    "Access-Control-Allow-Origin": "*",
                    "Access-Control-Allow-Methods": "OPTIONS,POST"
                }, 
                body: JSON.stringify({
                    message: `✅ Scheduled cost report successfully. It will run according to the specified cron expression: ${parsedJsonQuery.cronExpression}.`
                }),
            };
        } else if (intent.includes("resource level breakdown") || intent.includes("monthly billing") || intent.includes("daily billing")) {
            return await costReportHandler(parsedJsonQuery, userEmail, requestId, userCommand);
        } else if (intent.includes("anomaly report")) {
            return await incidentStatusHandler(parsedJsonQuery);
        } else {
            return {
                statusCode: 400,
                headers: {
                    "Access-Control-Allow-Origin": "*",
                    "Access-Control-Allow-Methods": "OPTIONS,POST"
                },
                body: JSON.stringify({
                    message: "❓ Sorry, I couldn't understand your request. Please try a cost or incident query, or ask to schedule a cost report.",
                }),
            };
        }
    } catch (error) {
        console.error(JSON.stringify({ level: 'error', msg: 'mainHandler error', error: error.message }));
        return {
            statusCode: 400,
            body: JSON.stringify({
                message: `❌ An error occurred: ${error.message}`,
            }),
        };
    }
};
