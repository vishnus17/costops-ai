import { DynamoDBClient, GetItemCommand, PutItemCommand, UpdateItemCommand } from "@aws-sdk/client-dynamodb";

export class DDBUtils {
    constructor({ region, reportsTable, cacheTable }) {
        this.dynamo = new DynamoDBClient({ region });
        this.reportsTable = reportsTable;
        this.cacheTable = cacheTable;
    }

    // --- Cache logic ---
    async getCache({ cacheKey, maxAgeMs = 12 * 60 * 60 * 1000 }) {
        try {
            const cacheResp = await this.dynamo.send(new GetItemCommand({
                TableName: this.cacheTable,
                Key: { cacheKey: { S: cacheKey } }
            }));
            if (cacheResp.Item && cacheResp.Item.data && cacheResp.Item.timestamp) {
                const cacheAge = Date.now() - Number(cacheResp.Item.timestamp.N);
                if (cacheAge < maxAgeMs) {
                    return {
                        data: JSON.parse(cacheResp.Item.data.S),
                        reportUrl: cacheResp.Item.reportUrl?.S || null,
                        hit: true
                    };
                }
            }
        } catch (err) {
            console.error(`[DDBUtils] Error checking cache: ${err.message}`);
        }
        return { hit: false };
    }

    async setCache({ cacheKey, data, reportUrl, ttlSeconds = 12 * 60 * 60 }) {
        const now = Date.now();
        const ttl = Math.floor(now / 1000) + ttlSeconds;
        await this.dynamo.send(new PutItemCommand({
            TableName: this.cacheTable,
            Item: {
                cacheKey: { S: cacheKey },
                data: { S: JSON.stringify(data) },
                reportUrl: { S: reportUrl },
                timestamp: { N: now.toString() },
                ttl: { N: ttl.toString() }
            }
        }));
    }

    // --- Report table logic ---
    async saveReport({ requestId, userCommand, parsedJsonQuery, reportUrl, costSummaryText, email }) {
        await this.dynamo.send(new PutItemCommand({
            TableName: this.reportsTable,
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

    async getReport(requestId) {
        const res = await this.dynamo.send(new GetItemCommand({
            TableName: this.reportsTable,
            Key: { requestId: { S: requestId } }
        }));
        return res.Item;
    }

    async updateEmail(requestId, email) {
        await this.dynamo.send(new UpdateItemCommand({
            TableName: this.reportsTable,
            Key: { requestId: { S: requestId } },
            UpdateExpression: "SET email = :e",
            ExpressionAttributeValues: { ":e": { S: email } }
        }));
    }

    async updateReportStatus(requestId, { reportUrl, costSummaryText }) {
        await this.dynamo.send(new UpdateItemCommand({
            TableName: this.reportsTable,
            Key: { requestId: { S: requestId } },
            UpdateExpression: "SET reportUrl = :u, costSummaryText = :t",
            ExpressionAttributeValues: {
                ":u": { S: reportUrl },
                ":t": { S: costSummaryText }
            }
        }));
    }
}
