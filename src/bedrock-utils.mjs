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
        - Focus on the resources with the highest cost in the last 14 days.
        - Use clear section headings (e.g., "AWS Resource Cost Report", "Top Resources by Spend", "Trends and Anomalies").
        - Use bullet points for notable trends or anomalies.
        - Do NOT use markdown, emojis, or any special formatting.
        - Keep the report clear and professional, using ONLY plain text.
        - At the end, provide a summary line with the resource with the highest cost and the total spend.

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

        Cost Explorer Data:
        ${JSON.stringify(data.ResultsByTime, null, 2)}
        `;
    }
}


// Bedrock function to parse user input into text
export function buildUserRequestPrompt(userCommand) {
    return `You are a Cloud Engineer. Parse this user input into a JSON request with the following fields: 'intent', 'days', 'includeAnomalies', 'startDate', 'endDate', and 'cronExpression'.
            - If the user asks for a monthly cost statement (e.g., "monthly cost", "this month"), set 'intent' to "monthly cost", and set 'startDate' and 'endDate' to the first and last day of the current month in ISO 8601 format (YYYY-MM-DD). Set 'days' to null.
            - If the user asks for the resource with the highest cost (e.g., "resource with highest cost", "most expensive resource"), set 'intent' to "resource with highest cost", set 'days' to 14, and leave 'startDate' and 'endDate' empty unless a specific range is mentioned.
            - If the user specifies a custom time period (like a month, year, or date range), extract and set 'startDate' and 'endDate' in ISO 8601 format (YYYY-MM-DD).
            - If not, use 'days' as a fallback.
            - By default, query for the current month if no specific time period is mentioned.
            - If the user asks to schedule or set up a recurring alert (e.g., "daily", "every Monday", "weekly", "every 1st of the month"), generate an AWS EventBridge-compatible cron expression and set it as 'cronExpression'.
            - Respond ONLY with a valid JSON object and nothing else.
            - The intent should ONLY be one of the following: "monthly cost", "resource with highest cost", "most expensive resource", "anomaly report", "schedule cost report", or "incident status".      
            User: ${userCommand}
            JSON:`;
}