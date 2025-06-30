import { CostExplorerClient, GetCostAndUsageCommand, GetCostAndUsageComparisonsCommand, GetCostAndUsageWithResourcesCommand } from "@aws-sdk/client-cost-explorer";

const region = process.env.AWS_REGION || 'ap-south-1';
const ceClient = new CostExplorerClient({ region });

/**
 * Get cost and usage data for a specific time period
 * @param {Object} params
 * @param {string} params.startDate - Start date in YYYY-MM-DD format
 * @param {string} params.endDate - End date in YYYY-MM-DD format
 * @param {string} params.granularity - DAILY or MONTHLY
 * @param {Array} params.groupBy - Array of group by objects
 * @param {Object} params.filter - Optional filter object
 * @returns {Promise<Object>} Cost and usage data
 */
export async function getCostAndUsage({ startDate, endDate, granularity = "DAILY", groupBy = [{ Type: "DIMENSION", Key: "SERVICE" }], filter = null }) {
    const params = {
        TimePeriod: {
            Start: startDate,
            End: endDate,
        },
        Granularity: granularity,
        Metrics: ["UnblendedCost"],
        GroupBy: groupBy,
    };

    if (filter) {
        params.Filter = filter;
    } else {
        // Default filter to exclude credits and refunds
        params.Filter = { Not: { Dimensions: { Key: "RECORD_TYPE", Values: ["Credit", "Refund"] } } };
    }

    return await ceClient.send(new GetCostAndUsageCommand(params));
}

/**
 * Get cost comparison between two time periods
 * @param {Object} params
 * @param {Object} params.baselineTimePeriod - { start: string, end: string }
 * @param {Object} params.comparisonTimePeriod - { start: string, end: string }
 * @param {string} params.metricForComparison - Metric to compare (e.g., "UnblendedCost")
 * @param {string} params.granularity - DAILY or MONTHLY
 * @param {Array} params.groupBy - Array of group by objects
 * @param {Object} params.filter - Optional filter object
 * @returns {Promise<Object>} Cost comparison data
 */
export async function getCostAndUsageComparisons({ 
    baselineTimePeriod, 
    comparisonTimePeriod, 
    metricForComparison = "UnblendedCost", 
    granularity = "MONTHLY", 
    groupBy = [{ Type: "DIMENSION", Key: "SERVICE" }], 
    filter = null 
}) {
    const params = {
        BaselineTimePeriod: { Start: baselineTimePeriod.start, End: baselineTimePeriod.end },
        ComparisonTimePeriod: { Start: comparisonTimePeriod.start, End: comparisonTimePeriod.end },
        MetricForComparison: metricForComparison,
        Granularity: granularity,
        GroupBy: groupBy,
    };

    if (filter) {
        params.Filter = filter;
    } else {
        // Default filter to exclude credits and refunds
        params.Filter = { Not: { Dimensions: { Key: "RECORD_TYPE", Values: ["Credit", "Refund"] } } };
    }

    return await ceClient.send(new GetCostAndUsageComparisonsCommand(params));
}

/**
 * Helper function to convert period objects to full calendar months
 * @param {Object} period - { start: string, end: string }
 * @returns {Object} Full calendar month period
 */
export function toFullMonthPeriod(period) {
    const start = new Date(period.start);
    const startYear = start.getFullYear();
    const startMonth = start.getMonth();
    const coercedStart = new Date(startYear, startMonth, 1);
    const coercedEnd = new Date(startYear, startMonth + 1, 1); // first of next month
    return {
        start: coercedStart.toISOString().slice(0, 10),
        end: coercedEnd.toISOString().slice(0, 10)
    };
}

/**
 * Prepare periods for AWS Cost Explorer comparison (baseline must be earlier)
 * @param {Object} period1 - { start: string, end: string }
 * @param {Object} period2 - { start: string, end: string }
 * @returns {Object} { baseline, comparison } with properly ordered periods
 */
export function prepareComparisonPeriods(period1, period2) {
    const normalizedPeriod1 = toFullMonthPeriod(period1);
    const normalizedPeriod2 = toFullMonthPeriod(period2);
    
    // Baseline must be the earlier month, comparison the later month
    if (new Date(normalizedPeriod1.start) < new Date(normalizedPeriod2.start)) {
        return { baseline: normalizedPeriod1, comparison: normalizedPeriod2 };
    } else {
        return { baseline: normalizedPeriod2, comparison: normalizedPeriod1 };
    }
}

/**
 * Get cost data with resource-level breakdown (can be resource-intensive)
 * @param {Object} params
 * @param {string} params.startDate - Start date in YYYY-MM-DD format
 * @param {string} params.endDate - End date in YYYY-MM-DD format
 * @param {string} params.granularity - DAILY or MONTHLY
 * @param {Object} params.filter - Optional filter object
 * @returns {Promise<Object>} Resource-level cost data
 */
export async function getResourceLevelCosts({ startDate, endDate, groupBy, granularity, filter = null }) {
    const params = {
        TimePeriod: {
            Start: startDate,
            End: endDate,
        },
        Granularity: granularity,
        Metrics: ["UnblendedCost"],
        GroupBy: groupBy || [{ Type: "DIMENSION", Key: "RESOURCE_ID" }],
    };

    if (filter) {
        params.Filter = filter;
    } else {
        // Default filter to exclude credits and refunds
        params.Filter = { Not: { Dimensions: { Key: "RECORD_TYPE", Values: ["Credit", "Refund"] } } };
    }

    return await ceClient.send(new GetCostAndUsageWithResourcesCommand(params));
}

/**
 * Get service-level cost data (standard breakdown)
 * @param {Object} params
 * @param {string} params.startDate - Start date in YYYY-MM-DD format
 * @param {string} params.endDate - End date in YYYY-MM-DD format
 * @param {string} params.granularity - DAILY or MONTHLY
 * @returns {Promise<Object>} Service-level cost data
 */
export async function getServiceLevelCosts({ startDate, endDate, granularity = "DAILY" }) {
    return await getCostAndUsage({
        startDate,
        endDate,
        granularity,
        groupBy: [{ Type: "DIMENSION", Key: "SERVICE" }],
        filter: { Not: { Dimensions: { Key: "RECORD_TYPE", Values: ["Credit", "Refund"] } } }
    });
}
