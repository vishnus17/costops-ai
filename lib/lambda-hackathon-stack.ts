import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { S3BucketOrigin } from 'aws-cdk-lib/aws-cloudfront-origins';

export class LambdaHackathonStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // S3 bucket for reports
    const reportsBucket = new cdk.aws_s3.Bucket(this, 'ReportsBucket', {
      bucketName: 'lambda-cost-reports',
      removalPolicy: cdk.RemovalPolicy.DESTROY, // For dev/demo only
      autoDeleteObjects: true, // For dev/demo only
      eventBridgeEnabled: false,
    });

    // SES for email notifications
    const sesIdentity = new cdk.aws_ses.EmailIdentity(this, 'EmailIdentity', {
      identity: cdk.aws_ses.Identity.publicHostedZone(
        cdk.aws_route53.HostedZone.fromLookup(this, 'MyZone', { domainName: 'learnmorecloud.com' }) // Replace with your domain
      ),
    });

    // CF distribution to display reports
    const distribution = new cdk.aws_cloudfront.Distribution(this, 'ReportsDistribution', {
      defaultBehavior: {
        origin: S3BucketOrigin.withOriginAccessControl(reportsBucket),
        viewerProtocolPolicy: cdk.aws_cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cdk.aws_cloudfront.AllowedMethods.ALLOW_GET_HEAD,
        cachedMethods: cdk.aws_cloudfront.CachedMethods.CACHE_GET_HEAD,
        cachePolicy: cdk.aws_cloudfront.CachePolicy.CACHING_OPTIMIZED_FOR_UNCOMPRESSED_OBJECTS
      },
      defaultRootObject: 'index.html',
    });
    
    // Lambda
    const lambdaFunction = new cdk.aws_lambda.Function(this, 'MyLambdaFunction', {
      functionName: 'DevOpsChatOpsLambda',
      description: 'Lambda function for DevOps ChatOps',
      runtime: cdk.aws_lambda.Runtime.NODEJS_22_X,
      handler: 'index.mainHandler',
      code: cdk.aws_lambda.Code.fromAsset('src'),
      timeout: cdk.Duration.seconds(60),
      memorySize: 1024,
      environment: {
        CF_URL: distribution.distributionDomainName,
      },
      initialPolicy: [
      // Grant access to Bedrock
      new cdk.aws_iam.PolicyStatement({
        actions: [
          "bedrock:InvokeModel",
          "bedrock:InvokeModelWithResponseStream",
          "bedrock:ListFoundationModels"
        ],
        resources: ["*"],
      }),
      // Grant access to Cost Explorer
      new cdk.aws_iam.PolicyStatement({
        actions: [
          "ce:GetCostAndUsage",
          "ce:GetCostForecast",
          "ce:GetDimensionValues",
          "ce:GetReservationUtilization",
          "ce:GetRightsizingRecommendation",
          "ce:GetSavingsPlansUtilization",
          "ce:GetSavingsPlansUtilizationDetails",
          "ce:GetSavingsPlansCoverage",
          "ce:GetTags",
          "ce:GetUsageForecast",
          "ce:GetCostAndUsageWithResources"
        ],
        resources: ["*"],
      }),
      // Access to Incident Manager
      new cdk.aws_iam.PolicyStatement({
        actions: [
          "ssm:List*",
          "ssm-incidents:List*",
      ],
        resources: ["*"],
      }),
    ],
      tracing: cdk.aws_lambda.Tracing.ACTIVE,
    });

    // Lambda for scheduled cost/anomaly reports
    const scheduledCostReportLambda = new cdk.aws_lambda.Function(this, 'ScheduledCostReportLambda', {
      functionName: 'ScheduledCostReportLambda',
      description: 'Lambda function for scheduled cost and anomaly reports',
      runtime: cdk.aws_lambda.Runtime.NODEJS_22_X,
      handler: 'scheduled-cost-report.scheduledCostReportHandler',
      code: cdk.aws_lambda.Code.fromAsset('src'),
      timeout: cdk.Duration.seconds(300),
      memorySize: 1024,
      environment: {
        REPORTS_BUCKET: reportsBucket.bucketName,
        CF_URL: distribution.distributionDomainName,
      },
      initialPolicy: [
        new cdk.aws_iam.PolicyStatement({
          actions: ['s3:PutObject'],
          resources: [reportsBucket.bucketArn + '/*'],
        }),
        new cdk.aws_iam.PolicyStatement({
          actions: [
            'ce:GetCostAndUsage',
            'ce:GetCostForecast',
            'ce:GetDimensionValues',
            'ce:GetReservationUtilization',
            'ce:GetRightsizingRecommendation',
            'ce:GetSavingsPlansUtilization',
            'ce:GetSavingsPlansUtilizationDetails',
            'ce:GetSavingsPlansCoverage',
            'ce:GetTags',
            'ce:GetUsageForecast',
            'ce:GetCostAndUsageWithResources',
          ],
          resources: ['*'],
        }),
      ],
      tracing: cdk.aws_lambda.Tracing.ACTIVE,
    });

    // Pass the scheduled Lambda ARN to the main Lambda for dynamic EventBridge rule creation
    lambdaFunction.addEnvironment('SCHEDULED_COST_REPORT_LAMBDA_ARN', scheduledCostReportLambda.functionArn);

    // Function to create EventBridge rule for scheduling (to be called programmatically)
    // This is a helper for when a user requests scheduling via chat
    const eventBridge = new cdk.aws_events.EventBus(this, 'ChatOpsEventBus', {
      eventBusName: 'ChatOpsEventBus',
    });

    // Grant permissions for Lambda to create rules/targets (if you want to do this from Lambda)
    scheduledCostReportLambda.addToRolePolicy(new cdk.aws_iam.PolicyStatement({
      actions: [
        'events:PutRule',
        'events:PutTargets',
        'events:DescribeRule',
        'events:DeleteRule',
        'events:RemoveTargets',
      ],
      resources: ['*'],
    }));

    // Grant write access to the main Lambda
    reportsBucket.grantPut(lambdaFunction);

    // Grant write access to scheduled report Lambda
    reportsBucket.grantPut(scheduledCostReportLambda);


    // (Optional) S3 event notification for scheduled reports folder
    reportsBucket.addEventNotification(
      cdk.aws_s3.EventType.OBJECT_CREATED,
      new cdk.aws_s3_notifications.LambdaDestination(scheduledCostReportLambda),
      { prefix: 'scheduled-reports/' }
    );

    // API Gateway
    const api = new cdk.aws_apigateway.RestApi(this, 'chatopsApi', {
      restApiName: 'api-devops-chatops',
      description: 'API for DevOps ChatOps',
      defaultCorsPreflightOptions: {
        allowOrigins: ["*"], // Allow all origins for demo purposes
        allowHeaders: ["Content-Type", "X-Amz-Date", "Authorization", "X-Api-Key", "X-Amz-Security-Token"],
        allowMethods: ["OPTIONS", "POST"], // Allow OPTIONS and POST methods
      },
    });

    const chatResource = api.root.addResource('chat');
    chatResource.addMethod('POST', new cdk.aws_apigateway.LambdaIntegration(lambdaFunction));

    // Outputs
    new cdk.CfnOutput(this, 'CFDistributionDomainName', {
      value: distribution.distributionDomainName,
      description: 'CloudFront Distribution Domain Name for reports',
    });

    new cdk.CfnOutput(this, 'APIEndpoint', {
      value: api.url,
      description: 'API Gateway endpoint for DevOps ChatOps',
    });

    // DynamoDB table for cost report requests
    const costReportTable = new cdk.aws_dynamodb.Table(this, 'CostReportRequests', {
      tableName: 'CostReportRequests',
      partitionKey: { name: 'requestId', type: cdk.aws_dynamodb.AttributeType.STRING },
      billingMode: cdk.aws_dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY, // For dev/demo only
      stream: cdk.aws_dynamodb.StreamViewType.NEW_IMAGE, // Enable stream for Lambda trigger
    });

    // Async Lambda for sending resource-level reports
    const asyncCostReportSender = new cdk.aws_lambda.Function(this, 'AsyncCostReportSender', {
      functionName: 'AsyncCostReportSender',
      description: 'Sends resource-level cost reports asynchronously when email is provided',
      runtime: cdk.aws_lambda.Runtime.NODEJS_22_X,
      handler: 'async-cost-report-sender.handler',
      code: cdk.aws_lambda.Code.fromAsset('src'),
      timeout: cdk.Duration.seconds(300),
      memorySize: 1024,
      environment: {
        REPORTS_BUCKET: reportsBucket.bucketName,
        CF_URL: distribution.distributionDomainName,
        REPORTS_DDB_TABLE: costReportTable.tableName,
        SES_IDENTITY: sesIdentity.emailIdentityName,
        AWS_NODEJS_CONNECTION_REUSE_ENABLED: '1',
      },
      initialPolicy: [
        new cdk.aws_iam.PolicyStatement({
          actions: [
            'dynamodb:GetItem', 'dynamodb:UpdateItem', 'dynamodb:PutItem', 'dynamodb:Scan', 'dynamodb:Query',
            'ses:SendEmail', 'ses:SendRawEmail',
            's3:PutObject',
            'ce:GetCostAndUsage', 'ce:GetCostAndUsageWithResources',
          ],
          resources: ['*'],
        }),
        // Grant access to Bedrock
        new cdk.aws_iam.PolicyStatement({
          actions: [
            "bedrock:InvokeModel",
            "bedrock:InvokeModelWithResponseStream",
            "bedrock:ListFoundationModels"
          ],
          resources: ["*"],
        }),
      ],
      tracing: cdk.aws_lambda.Tracing.ACTIVE,
    });

    // Grant permissions
    costReportTable.grantStreamRead(asyncCostReportSender);
    reportsBucket.grantPut(asyncCostReportSender);

    // Add DynamoDB stream as event source
    asyncCostReportSender.addEventSource(new cdk.aws_lambda_event_sources.DynamoEventSource(costReportTable, {
      startingPosition: cdk.aws_lambda.StartingPosition.LATEST,
      batchSize: 5,
      retryAttempts: 2,
    }));

    // Grant Lambda read/write permissions to the table
    costReportTable.grantReadWriteData(lambdaFunction);
    costReportTable.grantReadWriteData(scheduledCostReportLambda);

    // Pass table name as env var
    lambdaFunction.addEnvironment('REPORTS_DDB_TABLE', costReportTable.tableName);
    scheduledCostReportLambda.addEnvironment('REPORTS_DDB_TABLE', costReportTable.tableName);
  }
}
