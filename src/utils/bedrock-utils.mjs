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
            modelId: "us.amazon.nova-premier-v1:0",
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

export function buildCostSummaryPrompt(data, userCommand, granularity) {
    const totalCost = data.ResultsByTime.reduce((sum, entry) => {
        if (Array.isArray(entry.Groups)) {
            return sum + entry.Groups.reduce((gSum, group) => {
                const amount = group.Metrics?.UnblendedCost?.Amount;
                return gSum + (amount ? parseFloat(amount) : 0);
            }, 0);
        }
        return sum;
    }, 0);

    console.log("Total cost calculated:", totalCost);

    const reportInstructions = `
        As a cloud cost analyst, review the AWS Cost Explorer data and generate a summary:
        - If the user is requesting something specific in the ${userCommand}, focus on that.
        - Use clear section headings (e.g., "AWS Resource Cost Report", "Top Resources by Spend", "Trends and Anomalies" and "Summary").
        - Use bullet points for notable trends or anomalies.
        - Do NOT use markdown, emojis, or any special formatting.
        - Keep the report clear and professional, using ONLY plain text.
        - Include calculated total cost: \$\ ${totalCost.toFixed(2)}.
    `;

    if (granularity === "DAILY") {
        return `
        Analyze AWS costs by Top Resources.
        ${reportInstructions}
        Data:
        \ ${JSON.stringify(data.ResultsByTime, null, 2)}
        `;
    } 
    else if (granularity === "MONTHLY") {
        return `
        Analyze the monthly AWS costs.
        - ${reportInstructions}
        Data:
        \ ${JSON.stringify(data.ResultsByTime, null, 2)}
        `;
    } 
    else {
        return `
        Summarize AWS costs as per user request.
        - ${reportInstructions}
        Data:
        \ ${JSON.stringify(data.ResultsByTime, null, 2)}
        `;
    }
}

/**
 * Builds a summary prompt for Bedrock for month-to-month cost comparison.
 * @param {object} period1 - { start: string, end: string }
 * @param {object} period2 - { start: string, end: string }
 * @param {object} comparisonData - The AWS Cost Explorer comparison data.
 * @returns {string} The prompt string for Bedrock.
 */
export function buildMonthComparisonSummaryPrompt(period1, period2, comparisonData) {
    // Extract total costs
    const totalCosts = comparisonData.TotalCostAndUsage?.UnblendedCost || {};
    const baselineTotal = parseFloat(totalCosts.BaselineTimePeriodAmount || '0');
    const comparisonTotal = parseFloat(totalCosts.ComparisonTimePeriodAmount || '0');
    const totalDifference = parseFloat(totalCosts.Difference || '0');
    
    // Extract service-level data
    const serviceComparisons = comparisonData.CostAndUsageComparisons || [];
    const significantChanges = serviceComparisons
        .filter(service => {
            const diff = parseFloat(service.Metrics?.UnblendedCost?.Difference || '0');
            return Math.abs(diff) > 0.01; // Only show changes > $0.01
        })
        .sort((a, b) => {
            const diffA = Math.abs(parseFloat(a.Metrics?.UnblendedCost?.Difference || '0'));
            const diffB = Math.abs(parseFloat(b.Metrics?.UnblendedCost?.Difference || '0'));
            return diffB - diffA; // Sort by largest absolute difference first
        });

    let serviceBreakdown = '';
    significantChanges.slice(0, 10).forEach(service => {
        const serviceName = service.CostAndUsageSelector?.Dimensions?.Values?.[0] || 'Unknown Service';
        const baseline = parseFloat(service.Metrics?.UnblendedCost?.BaselineTimePeriodAmount || '0');
        const comparison = parseFloat(service.Metrics?.UnblendedCost?.ComparisonTimePeriodAmount || '0');
        const difference = parseFloat(service.Metrics?.UnblendedCost?.Difference || '0');
        const percentChange = baseline > 0 ? ((difference / baseline) * 100).toFixed(1) : 'N/A';
        
        serviceBreakdown += `- ${serviceName}: Baseline $${baseline.toFixed(2)}, Comparison $${comparison.toFixed(2)}, Difference ${difference >= 0 ? '+' : ''}$${difference.toFixed(2)} (${percentChange}% change)\n`;
    });

    return `As a cloud cost analyst, compare AWS costs between these two periods:
        Baseline Period: ${period2.start} to ${period2.end}
        Comparison Period: ${period1.start} to ${period1.end}

        TOTAL COST SUMMARY:
        - Baseline Period Total: $${baselineTotal.toFixed(2)}
        - Comparison Period Total: $${comparisonTotal.toFixed(2)}
        - Total Difference: ${totalDifference >= 0 ? '+' : ''}$${totalDifference.toFixed(2)}
        - Overall Change: ${baselineTotal > 0 ? ((totalDifference / baselineTotal) * 100).toFixed(1) : 'N/A'}%

        TOP SERVICE CHANGES:
        ${serviceBreakdown}

        Generate a professional analysis with these sections:
        - Use clear section headings (e.g., "Month-to-Month Cost Comparison", "Key Service Changes", "Cost Trends Analysis", "Summary and Recommendations")
        - Focus on the most significant cost changes and their business impact
        - Identify services with largest increases/decreases
        - Use bullet points for key findings
        - Do NOT use markdown, emojis, or any special formatting
        - Keep the report clear and professional, using ONLY plain text
        - Provide actionable insights based on the cost trends`;
}

// User input parser
export function buildUserRequestPrompt(userCommand) {
    const today = new Date();
    const todayStr = today.toISOString().split('T')[0];

    return `Convert this command to JSON:
    - 'intent': "monthly", "daily", "resource", "scheduled", or "compare-months"
    - ONLY for intent: "compare-months", include 'period1' and 'period2' as objects with 'start' and 'end' (YYYY-MM-DD). Convert exactly like this: For example if user asks to compare June and May, period1 should be June 01 till July 01 and period2 should be May 01 till June 01.
    - For other intents, include 'days', 'startDate', 'endDate' as normal and 'cronExpression' where needed. Refer this document for cron syntax: https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-scheduled-rule-pattern.html
    - If intent is scheduled, specify the "granularity" (e.g., "DAILY" or "MONTHLY").
    - If user has any special requirements, include them in 'specialRequirements'. For example, if users asks for top 5 costly service or resources.
    - Time references use ${todayStr} as today.
    - Cron format: cron(Minutes Hours Day-of-month Month Day-of-week Year).

    Input: ${userCommand}
    JSON:`;
}