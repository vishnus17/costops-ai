# Lambda Hackathon: Serverless AWS Cost & Incident Reporting

## Overview
This project is a modern, serverless AWS solution for automated cost and incident reporting, leveraging Lambda, DynamoDB, S3, SES, API Gateway, and Bedrock AI. It is designed for DevOps, FinOps, and CloudOps teams who want actionable, AI-powered cost insights and incident summaries delivered via API or scheduled email.

## Features
- **Automated Cost Reports**: Generate daily, monthly, or resource-level AWS cost reports on demand or on a schedule.
- **Incident & Anomaly Detection**: Summarize cost anomalies and incidents using Bedrock AI.
- **AI-Powered Summaries**: Bedrock prompts are engineered to ensure accurate, data-driven cost summaries (no guessing!).
- **Caching**: DynamoDB-backed caching for cost explorer queries and report URLs to minimize API calls and costs.
- **PDF & S3 Delivery**: Reports are generated as PDFs and stored in S3, with CloudFront distribution for secure access.
- **API Gateway**: REST API for chat-style cost/incident queries.
- **Email Notifications**: Scheduled or on-demand reports can be sent via SES.
- **Modular Utilities**: All AWS SDK logic is modularized for maintainability and testability.

## Architecture
- **Lambda Functions**
  - `DevOpsChatOpsLambda`: Main entry for API/chat requests.
  - `ScheduledCostReportLambda`: Handles scheduled cost/anomaly reports.
  - `AsyncCostReportSender`: Sends resource-level reports asynchronously.
- **DynamoDB**
  - `CostReportRequests`: Tracks report requests and metadata.
  - `CostExplorerCache`: Caches cost explorer results for performance.
- **S3**
  - `lambda-cost-reports`: Stores generated PDF reports.
- **CloudFront**
  - Distributes S3 reports securely.
- **SES**
  - Sends email notifications with report links.
- **API Gateway**
  - Exposes `/chat` endpoint for cost/incident queries.
- **Bedrock AI**
  - Summarizes cost and incident data with strict prompt engineering.

### Architecture Diagram

<p align="center">
  <img src="img/costops.svg" alt="Architecture Diagram" width="80%"/>
</p>

## Project Structure
```
lib/lambda-hackathon-stack.ts   # CDK stack (infrastructure as code)
src/lambdas/                   # Lambda handlers
src/utils/                     # Utility modules (DynamoDB, S3, Bedrock, PDF, etc.)
```

## How It Works
1. **User/API Request**: User sends a cost/incident query to the `/chat` API endpoint.
2. **Lambda Handler**: Main Lambda parses the request, checks cache, fetches data, and invokes Bedrock for summary.
3. **Report Generation**: PDF report is generated and uploaded to S3.
4. **Caching**: Results and URLs are cached in DynamoDB for fast future access.
5. **Delivery**: User receives a CloudFront URL or an email with the report.
6. **Scheduled Reports**: EventBridge triggers scheduled Lambda for recurring reports.

## Deployment
- Uses AWS CDK (TypeScript). Deploy with:
  ```sh
  npm install
  cdk deploy
  ```
- Ensure your AWS credentials and region are set up.

## Security & Best Practices
- All permissions are managed via least-privilege IAM policies.
- No resource.grant* methods; all access is explicit in the stack.
- Sensitive data is never logged.
- Modular code for easy testing and extension.

## Customization
- Update Bedrock prompts in `src/utils/bedrock-utils.mjs` for your reporting style.
- Add new Lambda handlers or utilities as needed.
- Adjust IAM policies in `lib/lambda-hackathon-stack.ts` for your org's requirements.

## Authors & Credits
- Built for the Lambda Hackathon by Learn More Cloud
- Uses AWS CDK, Lambda, DynamoDB, S3, SES, API Gateway, and Bedrock AI.

---
