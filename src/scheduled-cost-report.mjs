// Lambda to generate scheduled cost/anomaly reports and save to S3
import { CostExplorerClient, GetCostAndUsageCommand } from "@aws-sdk/client-cost-explorer";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

const s3 = new S3Client();
const S3_BUCKET = process.env.REPORTS_BUCKET || "lambda-cost-reports";

async function scheduledCostReportHandler(parsedQuery) {
    const ceClient = new CostExplorerClient({
        region: "us-east-1",
    });

    // Prefer explicit startDate/endDate if provided, else fallback to days
    let start, end;
    if (parsedQuery.startDate && parsedQuery.endDate) {
        start = new Date(parsedQuery.startDate);
        end = new Date(parsedQuery.endDate);
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
        Granularity: "DAILY",
        Metrics: ["UnblendedCost"],
        GroupBy: [{ Type: "DIMENSION", Key: "SERVICE" }],
    };

    const data = await ceClient.send(new GetCostAndUsageCommand(params));
    console.log("Cost Explorer output:", JSON.stringify(data, null, 2));

    // Prepare a summary prompt for Bedrock
    const summaryPrompt = `
    As a cloud cost analyst, review the following AWS Cost Explorer data (JSON) and generate a concise, attractive summary report. 
    - List all the services by cost (numbered, no asterisks, special symbols or markdown formatting).
    - Show the total spend.
    - Include the time period covered by the report.
    - Highlight any notable trends or anomalies.
    - Generate in tabular format if required.
    - Keep the report clear and professional, using plain text only.

    Cost Explorer Data:
    ${JSON.stringify(data.ResultsByTime, null, 2)}
    `;

    // Ask Bedrock to summarize the cost data
    const summaryPayload = {
        messages: [
            {
                content: [
                    {
                        text: summaryPrompt
                    }
                ],
                role: "user",
            }
        ],
    };

    const summaryResponse = await bedrock.send(
        new InvokeModelCommand({
            contentType: "application/json",
            body: JSON.stringify(summaryPayload),
            modelId: "amazon.nova-pro-v1:0",
        })
    );

    const summaryResult = JSON.parse(Buffer.from(summaryResponse.body).toString());
    let responseText;
    try {
        const contentArr = summaryResult.output?.message?.content;
        if (Array.isArray(contentArr) && contentArr.length > 0 && contentArr[0].text) {
            responseText = contentArr[0].text.trim();
        } else {
            throw new Error("Unexpected Bedrock summary output format");
        }
    } catch (e) {
        console.error("Failed to parse Bedrock summary output:", e);
        responseText = "Could not generate summary report.";
    }

    console.log("Cost report summary:", responseText);

    // Save the report to S3
    const reportKey = `cost-reports/${Date.now()}.txt`;
    await s3.send(new PutObjectCommand({
        Bucket: S3_BUCKET,
        Key: reportKey,
        Body: responseText,
        ContentType: "text/plain",
    }));

    // Generate a PDF (simple text-to-PDF using PDFKit)
    const pdfDoc = new PDFDocument();
    const pdfStream = new PassThrough();
    let pdfBuffer = Buffer.alloc(0);

    pdfDoc.pipe(pdfStream);
    pdfDoc.fontSize(16).text("AWS Cost Report", { underline: true });
    pdfDoc.moveDown();
    pdfDoc.fontSize(12).text(responseText);
    pdfDoc.end();

    for await (const chunk of pdfStream) {
        pdfBuffer = Buffer.concat([pdfBuffer, chunk]);
    }

    // Save PDF to S3
    const pdfKey = `cost-reports/${Date.now()}.pdf`;
    await s3.send(new PutObjectCommand({
        Bucket: S3_BUCKET,
        Key: pdfKey,
        Body: pdfBuffer,
        ContentType: "application/pdf",
    }));

    const reportUrl = `${CF_URL}/${pdfKey}`;
    console.log("Cost report PDF stored at:", reportUrl);
    return { 
        statusCode: 200,
        headers: {
            "Access-Control-Allow-Origin": "*", // or your domain
            "Access-Control-Allow-Methods": "OPTIONS,POST"
        },
        body: JSON.stringify({
            message: `Cost Report generated successfully✅. You can view the report here: ${reportUrl}`,
        })
    };
}