// ChatOps Lambda Functions: Cost + Incident AI Query Support via Amazon Bedrock (AWS SDK v3)

import { CostExplorerClient, GetCostAndUsageCommand } from "@aws-sdk/client-cost-explorer";
import { SSMIncidentsClient, ListIncidentRecordsCommand } from "@aws-sdk/client-ssm-incidents";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { EventBridgeClient, PutRuleCommand, PutTargetsCommand } from "@aws-sdk/client-eventbridge";
import { askBedrock, buildCostSummaryPrompt, buildUserRequestPrompt } from "./bedrock-utils.mjs";
import { generateCostReportPDF } from "./pdf-utils.mjs";
import { DynamoDBClient, PutItemCommand, GetItemCommand, UpdateItemCommand } from "@aws-sdk/client-dynamodb";
import { v4 as uuidv4 } from "uuid";

const region = 'ap-south-1';
const s3 = new S3Client({region});
const dynamo = new DynamoDBClient({region});
const S3_BUCKET = process.env.REPORTS_BUCKET || "lambda-cost-reports";
const DDB_TABLE = process.env.REPORTS_DDB_TABLE || "CostReportRequests";
const CF_URL = process.env.CF_URL;


// Helper to create a recurring EventBridge rule for scheduled cost reports
async function createRecurringCostReportRule({ days, cronExpression }) {
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
                Id: `ScheduledCostReportTarget-${userId}`,
                Arn: process.env.SCHEDULED_COST_REPORT_LAMBDA_ARN,
                Input: JSON.stringify({ days })
            }
        ]
    }));
}

async function saveReportToDynamo({ requestId, userCommand, parsedJsonQuery, reportUrl, costSummaryText, email }) {
    await dynamo.send(new PutItemCommand({
        TableName: DDB_TABLE,
        Item: {
            requestId: { S: requestId },
            userCommand: { S: userCommand },
            parsedJsonQuery: { S: JSON.stringify(parsedJsonQuery) },
            reportUrl: { S: reportUrl },
            costSummaryText: { S: costSummaryText },
            createdAt: { S: new Date().toISOString() },
            ...(email ? { email: { S: email } } : {})
        }
    }));
}

async function getReportFromDynamo(requestId) {
    const res = await dynamo.send(new GetItemCommand({
        TableName: DDB_TABLE,
        Key: { requestId: { S: requestId } }
    }));
    return res.Item;
}

async function updateEmailInDynamo(requestId, email) {
    await dynamo.send(new UpdateItemCommand({
        TableName: DDB_TABLE,
        Key: { requestId: { S: requestId } },
        UpdateExpression: "SET email = :e",
        ExpressionAttributeValues: { ":e": { S: email } }
    }));
}

async function costReportHandler(parsedQuery, userEmail = null, requestId = null, userCommand = "") {
    const intent = (parsedQuery.intent || "").toLowerCase();
    let isResourceLevel = intent.includes("highest cost") || intent.includes("most expensive resource");
    requestId = requestId || uuidv4();

    if (isResourceLevel) {
        // Resource-level cost breakdowns are now handled asynchronously
        // Save the request to DynamoDB for background processing and return
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

    const data = await ceClient.send(new GetCostAndUsageCommand(params));

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
                "Access-Control-Allow-Origin": "*", // or your domain
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
                "Access-Control-Allow-Origin": "*", // or your domain
                "Access-Control-Allow-Methods": "OPTIONS,POST"
            },
            body: JSON.stringify({
                message: `❌ Failed to fetch incidents: ${err.message}`,
            }),
        };
    }
}

// Main handler that dynamically invokes the necessary function
export const mainHandler = async (event) => {
    try {
        const body = JSON.parse(event.body);
        const userCommand = body.message;
        const userEmail = body.email || null;
        const requestId = body.requestId || null;

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
        
        if (intent.includes("schedule")) {
            await createRecurringCostReportRule({
                days: parsedJsonQuery.days || 7,
                cronExpression: parsedJsonQuery.cronExpression || 'cron(0 8 * * ? *)'
            });
            return { 
                statusCode: 200,
                headers: {
                    "Access-Control-Allow-Origin": "*",
                    "Access-Control-Allow-Methods": "OPTIONS,POST"
                }, 
                body: JSON.stringify({
                    message: `✅ Scheduled cost report successfully. It will run according to the specified cron expression: ${parsedQuery.cronExpression || 'cron(0 8 * * ? *)'}.`
                }),
            };
        } else if (intent.includes("cost")) {
            return await costReportHandler(parsedJsonQuery, userEmail, requestId, userCommand);
        } else if (intent.includes("incident")) {
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
        console.error("mainHandler error:", error);
        return {
            statusCode: 400,
            body: JSON.stringify({
                message: `❌ An error occurred: ${error.message}`,
            }),
        };
    }
};
