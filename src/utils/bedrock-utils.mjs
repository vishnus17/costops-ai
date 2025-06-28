import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";

const bedrock = new BedrockRuntimeClient({ region: "us-east-1" });

export async function askBedrock(prompt) {
    const payload = {
        messages: [
            {
                content: [{ text: prompt }],
                role: "user",
            }
        ],
    };

    const response = await bedrock.send(
        new InvokeModelCommand({
            contentType: "application/json",
            body: JSON.stringify(payload),
            modelId: "amazon.nova-pro-v1:0",
        })
    );

    const result = JSON.parse(Buffer.from(response.body).toString());
    let parsed;
    try {
        const contentArr = result.output?.message?.content;
        if (Array.isArray(contentArr) && contentArr.length > 0 && contentArr[0].text) {
            parsed = contentArr[0].text;
        } else {
            throw new Error("Unexpected Bedrock summary output format");
        }
    } catch (e) {
        console.error("Failed to parse Bedrock summary output:", e);
        parsed = "Could not generate summary report.";
    }
    return parsed;
}

export function buildCostSummaryPrompt(data, granularity, groupBy) {
    if (groupBy[0].Key === "RESOURCE_ID") {
        return `
        As a cloud cost analyst, review the following AWS Cost Explorer data (JSON) and generate a concise summary report for a PDF document in plain text.
        - Focus on the resources with the highest cost in the specified time period.
        - Use clear section headings (e.g., "AWS Resource Cost Report", "Top Resources by Spend", "Trends and Anomalies").
        - Use bullet points for notable trends or anomalies.
        - Do NOT use markdown, emojis, or any special formatting.
        - Keep the report clear and professional, using ONLY plain text.
        - At the end, provide a summary line with the resource with the highest cost and the total spend.
        - IMPORTANT: Calculate and include the total cost sum from the provided data. Do NOT estimate or guess. Only use the numbers in the data.

        Cost Explorer Data:
        ${JSON.stringify(data.ResultsByTime, null, 2)}
        `;
    } else if (granularity === "MONTHLY") {
        return `
        As a cloud cost analyst, review the following AWS Cost Explorer data (JSON) and generate a concise monthly summary report for a PDF document in plain text.
        - Use clear section headings (e.g., "AWS Monthly Cost Report", "Total Monthly Spend", "Service Breakdown", "Trends and Anomalies").
        - Use bullet points for notable trends or anomalies.
        - Do NOT use markdown, emojis, or any special formatting.
        - Keep the report clear and professional, using ONLY plain text.
        - At the end, provide a summary line with the total monthly spend and the time period covered.
        - IMPORTANT: Calculate and include the total cost sum from the provided data. Do NOT estimate or guess. Only use the numbers in the data.

        Cost Explorer Data:
        ${JSON.stringify(data.ResultsByTime, null, 2)}
        `;
    } else {
        return `
        As a cloud cost analyst, review the following AWS Cost Explorer data (JSON) and generate a concise summary report for a PDF document in plain text.
        - Use clear section headings (e.g., "AWS Cost Report", "Total Spend", "Service Breakdown", "Trends and Anomalies").
        - Use bullet points for notable trends or anomalies.
        - Do NOT use markdown, emojis, or any special formatting.
        - Keep the report clear and professional, using ONLY plain text.
        - At the end, provide a summary line with the total spend and the time period covered.
        - IMPORTANT: Calculate and include the total cost sum from the provided data. Do NOT estimate or guess. Only use the numbers in the data.

        Cost Explorer Data:
        ${JSON.stringify(data.ResultsByTime, null, 2)}
        `;
    }
}


// Bedrock function to parse user input into text
export function buildUserRequestPrompt(userCommand) {
    const today = new Date();
    const todayStr = today.toISOString().split('T')[0];
    return `You are a Cloud Engineer. Parse this user input into a JSON request with the following fields: 'intent', 'days', 'includeAnomalies', 'startDate', 'endDate', and 'cronExpression'.
            - Always use the current date (today: ${todayStr}) as the reference for any relative time phrases (e.g., 'last 7 days', 'this month', 'yesterday').
            - Classify the 'intent' as one of ONLY the following: "monthly billing", "daily billing", "resource level breakdown", "anomaly report", or "scheduled cost report".
            - If the user asks for a monthly cost statement (e.g., "monthly cost", "this month"), set 'intent' to "monthly billing", and set 'startDate' and 'endDate' to the first and last day of the current month in ISO 8601 format (YYYY-MM-DD). Set 'days' to null.
            - If the user asks for a daily cost statement (e.g., "daily cost", "today", "yesterday"), set 'intent' to "daily billing", and set 'startDate' and 'endDate' to the relevant day(s) in ISO 8601 format (YYYY-MM-DD). Set 'days' to 1 if only one day is requested.
            - If the user asks for a resource-level breakdown or the resource with the highest cost (e.g., "resource with highest cost", "most expensive resource", "resource breakdown"), set 'intent' to "resource level breakdown", set 'days' to 14, and leave 'startDate' and 'endDate' empty UNLESS a specific date range or number of days is mentioned.
            - If the user asks for anomalies or incidents, set 'intent' to "anomaly report". This is for incident management.
            - If the user asks to schedule or set up a recurring alert (e.g., "daily", "every Monday", "weekly", "biweekly", "every 1st of the month"), set 'intent' to "scheduled cost report". You MUST also set either 'days' or both 'startDate' and 'endDate' (ISO 8601 format) for the report period as per the user's request. If not specified, default to the last 7 days (days: 7). Generate a valid AWS EventBridge cron expression and set it as 'cronExpression'.
            - The cron expression MUST be wrapped in cron(...), must have 6 fields (Minutes Hours Day-of-month Month Day-of-week Year), and must follow AWS EventBridge syntax. Do NOT use both '?' in Day-of-month and Day-of-week.
            - Use this document for reference for AWS cron expressions: https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-scheduled-rule-pattern.html
            - If the user specifies a custom time period (like a month, year, or date range), extract and set 'startDate' and 'endDate' in ISO 8601 format (YYYY-MM-DD).
            - If not, use 'days' as a fallback.
            - Respond ONLY with a valid JSON object and nothing else.
            User: ${userCommand}
            JSON:`;
}