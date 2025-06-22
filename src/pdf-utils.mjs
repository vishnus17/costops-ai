import PDFDocument from "pdfkit";

export async function generateCostReportPDF(responseText, data) {
    const doc = new PDFDocument({ margin: 50 });
    const pdfChunks = [];
    let pdfUploadError = null;

    const pdfPromise = new Promise((resolve, reject) => {
        doc.on('data', chunk => pdfChunks.push(chunk));
        doc.on('end', () => resolve(Buffer.concat(pdfChunks)));
        doc.on('error', reject);
    });

    // --- PDFKit text rendering with improved style ---
    const lines = responseText.split('\n');
    let inTable = false;
    let renderedTitle = false;
    lines.forEach(line => {
        const trimmed = line.trim();

        if (!renderedTitle && /^aws (cost|monthly cost|resource cost) report$/i.test(trimmed)) {
            doc.moveDown(0.5);
            doc.font('Helvetica-Bold').fontSize(24).fillColor('#2c3e50').text(trimmed, { align: 'center', underline: true });
            doc.moveDown(1.5);
            renderedTitle = true;
        }
        else if (
            /^(total (spend|monthly spend)|service breakdown|top resources by spend|trends and anomalies)$/i.test(trimmed.replace(":", ""))
        ) {
            doc.moveDown(1);
            doc.font('Helvetica-Bold').fontSize(16).fillColor('#34495e').text(trimmed.replace(":", ""), { underline: true });
            doc.moveDown(0.5);
            inTable = trimmed.toLowerCase().includes('service breakdown') || trimmed.toLowerCase().includes('top resources by spend');
        }
        else if (inTable && /^(\s*service|\s*resource id)\s+cost/i.test(trimmed)) {
            doc.font('Courier-Bold').fontSize(12).fillColor('#222').text(trimmed);
            doc.moveTo(doc.x, doc.y).lineTo(doc.page.width - doc.page.margins.right, doc.y).strokeColor('#bbb').stroke();
        }
        else if (inTable && trimmed && /\$\d/.test(trimmed)) {
            doc.font('Courier').fontSize(12).fillColor('#222').text(trimmed);
        }
        else if (trimmed.startsWith("-")) {
            doc.font('Helvetica').fontSize(12).fillColor('#222').text(trimmed, { indent: 20 });
        }
        else if (inTable && trimmed === "") {
            inTable = false;
            doc.moveDown(0.5);
        }
        else if (trimmed) {
            doc.font('Helvetica').fontSize(12).fillColor('#222').text(trimmed);
        }
    });

    doc.moveDown(1.5);

    // Pie chart logic (same as your current implementation)
    const costData = data.ResultsByTime || [];
    const serviceCostMap = {};

    costData.forEach(day => {
        (day.Groups || []).forEach(group => {
            const service = group.Keys[0];
            const amount = parseFloat(group.Metrics.UnblendedCost.Amount);
            if (!serviceCostMap[service]) {
                serviceCostMap[service] = 0;
            }
            serviceCostMap[service] += amount;
        });
    });

    const serviceCosts = Object.entries(serviceCostMap)
        .map(([service, cost]) => ({ service, cost }))
        .filter(s => s.cost > 0)
        .sort((a, b) => b.cost - a.cost);

    if (serviceCosts.length > 0) {
        // Pie chart heading
        doc.moveDown(1);
        doc.font('Helvetica-Bold').fontSize(16).fillColor('#2c3e50').text('AWS Cost Distribution by Service', { align: 'center', underline: true });
        doc.moveDown(0.5);
        const pieChartHeight = 2 * 80 + 60 + (serviceCosts.slice(0, 10).length * 16) + 40;
        if (doc.y + pieChartHeight > doc.page.height - doc.page.margins.bottom) {
            doc.addPage();
        }
        const centerX = doc.page.width / 2;
        const centerY = doc.y + 100;
        const radius = 80;
        const total = serviceCosts.reduce((sum, s) => sum + s.cost, 0);
        let angle = 0;
        const colors = [
            '#3366CC', '#DC3912', '#FF9900', '#109618', '#990099',
            '#0099C6', '#DD4477', '#66AA00', '#B82E2E', '#316395'
        ];

        doc.save();
        doc.circle(centerX + 3, centerY + 3, radius + 2).fillOpacity(0.1).fill('#000').restore();

        serviceCosts.forEach((s, i) => {
            const sliceAngle = (s.cost / total) * Math.PI * 2;
            doc.save();
            doc.moveTo(centerX, centerY)
                .lineTo(centerX + radius * Math.cos(angle), centerY + radius * Math.sin(angle))
                .arc(centerX, centerY, radius, angle, angle + sliceAngle)
                .lineTo(centerX, centerY)
                .fillAndStroke(colors[i % colors.length], '#fff');
            doc.restore();
            angle += sliceAngle;
        });

        const legendX = centerX + radius + 40;
        let legendY = centerY - radius;
        doc.font('Helvetica-Bold').fontSize(12).fillColor('#222').text('Service Breakdown', legendX, legendY, { continued: false });
        legendY += 28; // Increased spacing after title
        const legendBoxSize = 14; // Slightly larger color box
        const legendTextOffset = 22; // More space between box and text
        const legendMaxWidth = doc.page.width - legendX - 20; // Prevent overflow
        const legendFont = 'Helvetica';
        const legendFontSize = 10;
        doc.font(legendFont).fontSize(legendFontSize);
        const legendEntrySpacing = 6; // Minimum spacing between entries
        serviceCosts.slice(0, 30).forEach((s, i) => {
            // Prepare legend text
            const percent = ((s.cost / total) * 100).toFixed(1);
            const legendText = `${s.service}: $${s.cost.toFixed(2)} (${percent}%)`;
            // Calculate height needed for this legend entry
            const textHeight = doc.heightOfString(legendText, {
                width: legendMaxWidth - legendTextOffset,
                align: 'left',
            });
            const entryHeight = Math.max(legendBoxSize, textHeight) + legendEntrySpacing;
            // If legend would overflow page, add a new page and reset legendY
            if (legendY + entryHeight > doc.page.height - doc.page.margins.bottom) {
                doc.addPage();
                legendY = doc.page.margins.top;
            }
            // Draw color box
            doc.rect(legendX, legendY, legendBoxSize, legendBoxSize).fill(colors[i % colors.length]).stroke();
            // Draw legend text (auto-wraps if too long)
            doc.font(legendFont).fontSize(legendFontSize).fillColor('#222').text(
                legendText,
                legendX + legendTextOffset,
                legendY + 2,
                { width: legendMaxWidth - legendTextOffset, continued: false, ellipsis: true }
            );
            legendY += entryHeight;
        });
        doc.moveDown(8);
    }

    doc.end();
    return pdfPromise;
}