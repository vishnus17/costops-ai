# Lambda Hackathon: Serverless AWS Cost & Incident Reporting

## Overview
This project is a modern, serverless AWS solution for automated cost and incident reporting, leveraging Lambda, DynamoDB, S3, CloudFront, SES, EventBridge, API Gateway, and Bedrock AI. It is designed for DevOps, FinOps, and CloudOps teams who want actionable, AI-powered cost insights and incident summaries delivered via API or scheduled email.

### Architecture Diagram

<p align="center">
  <img src="img/costopsAI.svg" alt="Architecture Diagram" width="100%"/>
</p>

## Architecture
- **Lambda Functions**
  - `DevOpsChatOpsLambda`: Main entry for API/chat requests.
  - `ScheduledCostReportLambda`: Handles scheduled cost reports.
  - `AsyncCostReportSender`: Sends resource-level reports asynchronously.
  - `Pre-signup`: Validate Signup emails for a company to restrict access.
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


## Features
- **Automated Cost Reports**: Generate daily, monthly, or resource-level AWS cost reports on demand or on a schedule.
- **Month-to-Month Comparisons**: AI-powered cost comparison reports between different time periods with detailed variance analysis.
- **Incident & Anomaly Detection**: Summarize cost anomalies and incidents using Bedrock AI.
- **AI-Powered Summaries**: Bedrock prompts are engineered to ensure accurate, data-driven cost summaries with special requirements support.
- **Intelligent Caching**: DynamoDB-backed caching for cost explorer queries and report URLs with cache validation before async processing.
- **PDF & S3 Delivery**: Reports are generated as PDFs and stored in S3, with CloudFront distribution for secure access.
- **API Gateway**: REST API for chat-style cost/incident queries with Cognito authentication.
- **Email Notifications**: Scheduled or on-demand reports can be sent via SES with comprehensive email templates.
- **Modular Cost Explorer Utilities**: All AWS Cost Explorer logic centralized in shared utility modules for maintainability.

## Technical Highlights

### Performance Optimizations
- **Cache-First Strategy**: All report types check cache before making expensive API calls
- **Async Resource Processing**: Resource-level reports processed asynchronously to prevent Lambda timeouts
- **Intelligent Caching**: Cache keys include all relevant parameters including special requirements
- **Summary Caching**: Complete report summaries cached for instant responses

### Maintainability Features
- **Centralized Cost Explorer Logic**: All AWS Cost Explorer commands in shared utility module
- **Consistent Error Handling**: Standardized try-catch patterns with structured logging
- **Modular Architecture**: Clean separation of concerns across Lambda functions
- **Utility-Based Design**: Reusable utilities for common operations (DynamoDB, S3, PDF generation)

### AI Integration
- **Intelligent Prompt Engineering**: Specialized prompts for different report types
- **Month Comparison Analysis**: AI extracts key metrics and variance data from Cost Explorer responses
- **Special Requirements Processing**: AI handles custom user requirements in report generation
- **Professional Formatting**: Consistent, professional report formatting

### Scalability Considerations
- **DynamoDB Streams**: Automatic async processing trigger for resource-level reports
- **CloudFront Distribution**: Scalable report delivery via CDN
- **EventBridge Scheduling**: Scalable scheduled report processing
- **Cognito Authentication**: Scalable user authentication and authorization

## Project Structure
```
lib/lambda-hackathon-stack.ts   # CDK stack (infrastructure as code)
src/lambdas/                   # Lambda handlers
  ├── index.mjs                # Main ChatOps handler with intelligent caching
  ├── scheduled-cost-report.mjs # Scheduled reports with user command validation
  └── async-cost-report-sender.mjs # Async resource-level report processing
src/utils/                     # Utility modules
  ├── cost-explorer-utils.mjs  # Centralized Cost Explorer API commands
  ├── bedrock-utils.mjs        # AI prompt engineering and response parsing
  ├── dynamodb-utils.mjs       # DynamoDB operations with error handling
  └── pdf-utils.mjs            # PDF report generation
```

## How It Works

### Standard Reports
1. **User/API Request**: User sends a cost query to the `/chat` API endpoint.
2. **Cache Validation**: Main Lambda checks DynamoDB cache for existing reports before processing.
3. **Cost Data Retrieval**: Uses centralized Cost Explorer utilities to fetch data if not cached.
4. **AI Processing**: Bedrock generates intelligent summaries with special requirements support.
5. **Report Generation**: PDF report is generated and uploaded to S3 with CloudFront URL.
6. **Caching**: Results, URLs, and summaries are cached in DynamoDB for future requests.

### Month-to-Month Comparisons
1. **Period Normalization**: Automatically converts user periods to full calendar months.
2. **Comparison Processing**: Uses dedicated Cost Explorer comparison APIs.
3. **Variance Analysis**: AI extracts key metrics and service-level changes.
4. **Professional Reporting**: Generates formatted comparison reports with insights.

### Resource-Level Reports
1. **Cache Check**: Validates cache for existing resource-level reports first.
2. **Async Processing**: If not cached, triggers async Lambda via DynamoDB stream.
3. **Email Delivery**: Resource-intensive reports are emailed when complete.
4. **Cache Population**: Results are cached for future identical requests.

### Scheduled Reports
1. **Command Parsing**: Validates user commands to determine specific report requirements.
2. **EventBridge Triggers**: Scheduled Lambda executes based on cron expressions.
3. **Intelligent Processing**: Determines report type (service vs resource level) from user intent.
4. **Automated Delivery**: Reports are generated and optionally emailed to recipients.

## Deployment
- Uses AWS CDK (TypeScript). Deploy with:
  ```sh
  npm install
  cdk deploy
  ```
- Ensure your AWS credentials and region are set up.

## Security & Best Practices
- **Least Privilege IAM**: All permissions are managed via explicit, minimal IAM policies.
- **No Resource Grants**: All access is explicitly defined in the CDK stack for security transparency.
- **Centralized Utilities**: Cost Explorer logic centralized for consistency and security.
- **Error Handling**: Comprehensive error handling with structured logging for operational security.
- **Cache Validation**: Intelligent caching prevents unnecessary API calls while maintaining data accuracy.
- **Async Processing**: Resource-intensive operations are handled asynchronously to prevent timeouts.
- **Sensitive Data Protection**: No sensitive data is logged; errors include only necessary context.

---
