import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { S3BucketOrigin } from 'aws-cdk-lib/aws-cloudfront-origins';

export interface LambdaHackathonStackProps extends cdk.StackProps {
  domainName: string;
}

export class LambdaHackathonStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: LambdaHackathonStackProps) {
    super(scope, id, props);

    const domainName = props?.domainName;

    // SES for email notifications
    const sesIdentity = new cdk.aws_ses.EmailIdentity(this, 'EmailIdentity', {
      identity: cdk.aws_ses.Identity.publicHostedZone(
        cdk.aws_route53.HostedZone.fromLookup(this, 'MyZone', { domainName: 'learnmorecloud.com' })
      ),
    });

    // DDB for cost reports
    const costReportTable = new cdk.aws_dynamodb.Table(this, 'CostReportRequests', {
      tableName: 'CostReportRequests',
      partitionKey: { name: 'requestId', type: cdk.aws_dynamodb.AttributeType.STRING },
      billingMode: cdk.aws_dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      stream: cdk.aws_dynamodb.StreamViewType.NEW_IMAGE,
    });

    // DDB for Cost Explorer cache
    const costExplorerCacheTable = new cdk.aws_dynamodb.Table(this, 'CostExplorerCache', {
      tableName: 'CostExplorerCache',
      partitionKey: { name: 'cacheKey', type: cdk.aws_dynamodb.AttributeType.STRING },
      billingMode: cdk.aws_dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // S3 bucket for reports
    const reportsBucket = new cdk.aws_s3.Bucket(this, 'ReportsBucket', {
      bucketName: 'lambda-cost-reports',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // Cert SSM store
    const certArn = cdk.aws_ssm.StringParameter.valueForStringParameter(this, '/ue1/certificateArn');

    // ACM cert
    const certificate = cdk.aws_certificatemanager.Certificate.fromCertificateArn(
      this, 'Certificate', certArn
    );

    // CloudFront distribution
    const distribution = new cdk.aws_cloudfront.Distribution(this, 'ReportsDistribution', {
      defaultBehavior: {
        origin: S3BucketOrigin.withOriginAccessControl(reportsBucket),
        viewerProtocolPolicy: cdk.aws_cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cdk.aws_cloudfront.AllowedMethods.ALLOW_GET_HEAD,
        cachedMethods: cdk.aws_cloudfront.CachedMethods.CACHE_GET_HEAD,
        cachePolicy: cdk.aws_cloudfront.CachePolicy.CACHING_OPTIMIZED_FOR_UNCOMPRESSED_OBJECTS
      },
      domainNames: [domainName],
      certificate: certificate,
      defaultRootObject: 'index.html',
    });

    // IAM policy statements (least privilege)
    const bedrockPolicy = new cdk.aws_iam.PolicyStatement({
      actions: [
        "bedrock:InvokeModel",
        "bedrock:InvokeModelWithResponseStream",
        "bedrock:ListFoundationModels"
      ],
      resources: ["*"],
    });
    const cePolicy = new cdk.aws_iam.PolicyStatement({
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
        "ce:GetCostAndUsageWithResources",
        "ce:GetCostAndUsageComparisons"
      ],
      resources: ["*"],
    });
    const ssmPolicy = new cdk.aws_iam.PolicyStatement({
      actions: [
        "ssm:List*",
        "ssm-incidents:List*",
        "events:PutRule",
        "events:PutTargets",
      ],
      resources: ["*"],
    });
    const s3PutPolicy = new cdk.aws_iam.PolicyStatement({
      actions: ['s3:PutObject'],
      resources: [reportsBucket.arnForObjects('*')],
    });
    const ddbRWPolicy = new cdk.aws_iam.PolicyStatement({
      actions: [
        'dynamodb:GetItem', 'dynamodb:UpdateItem', 'dynamodb:PutItem', 'dynamodb:Scan', 'dynamodb:Query', 'dynamodb:GetRecords'
      ],
      resources: [costReportTable.tableArn, costExplorerCacheTable.tableArn],
    });
    const sesPolicy = new cdk.aws_iam.PolicyStatement({
      actions: ['ses:SendEmail', 'ses:SendRawEmail'],
      resources: ['*'],
    });

    // === Lambda Functions ===

    // Lambda for scheduled cost/anomaly reports
    const scheduledCostReportLambda = new cdk.aws_lambda.Function(this, 'ScheduledCostReportLambda', {
      functionName: 'ScheduledCostReportLambda',
      description: 'Lambda function for scheduled cost and anomaly reports',
      runtime: cdk.aws_lambda.Runtime.NODEJS_22_X,
      handler: 'lambdas/scheduled-cost-report.scheduledCostReportHandler',
      code: cdk.aws_lambda.Code.fromAsset('src'),
      timeout: cdk.Duration.seconds(300),
      memorySize: 1024,
      environment: {
        REPORTS_BUCKET: reportsBucket.bucketName,
        CF_URL: domainName,
        REPORTS_DDB_TABLE: costReportTable.tableName,
        COST_EXPLORER_CACHE_TABLE: costExplorerCacheTable.tableName,
      },
      initialPolicy: [s3PutPolicy, cePolicy, bedrockPolicy, ddbRWPolicy, sesPolicy],
      tracing: cdk.aws_lambda.Tracing.ACTIVE,
    });

    // Main Lambda function for DevOps ChatOps
    const lambdaFunction = new cdk.aws_lambda.Function(this, 'MyLambdaFunction', {
      functionName: 'DevOpsChatOpsLambda',
      description: 'Lambda function for DevOps ChatOps',
      runtime: cdk.aws_lambda.Runtime.NODEJS_22_X,
      handler: 'lambdas/index.mainHandler',
      code: cdk.aws_lambda.Code.fromAsset('src'),
      timeout: cdk.Duration.seconds(60),
      memorySize: 1024,
      environment: {
        CF_URL: domainName,
        REPORTS_BUCKET: reportsBucket.bucketName,
        REPORTS_DDB_TABLE: costReportTable.tableName,
        COST_EXPLORER_CACHE_TABLE: costExplorerCacheTable.tableName,
        SCHEDULED_COST_REPORT_LAMBDA_ARN: scheduledCostReportLambda.functionArn,
      },
      initialPolicy: [bedrockPolicy, cePolicy, ssmPolicy, ddbRWPolicy, s3PutPolicy],
      tracing: cdk.aws_lambda.Tracing.ACTIVE,
    });

    // Async Lambda for sending resource-level reports
    const asyncCostReportSender = new cdk.aws_lambda.Function(this, 'AsyncCostReportSender', {
      functionName: 'AsyncCostReportSender',
      description: 'Sends resource-level cost reports asynchronously when email is provided',
      runtime: cdk.aws_lambda.Runtime.NODEJS_22_X,
      handler: 'lambdas/async-cost-report-sender.handler',
      code: cdk.aws_lambda.Code.fromAsset('src'),
      timeout: cdk.Duration.seconds(300),
      memorySize: 1024,
      environment: {
        REPORTS_BUCKET: reportsBucket.bucketName,
        CF_URL: domainName,
        REPORTS_DDB_TABLE: costReportTable.tableName,
        COST_EXPLORER_CACHE_TABLE: costExplorerCacheTable.tableName,
        SES_IDENTITY: sesIdentity.emailIdentityName,
        AWS_NODEJS_CONNECTION_REUSE_ENABLED: '1',
      },
      initialPolicy: [ddbRWPolicy, sesPolicy, s3PutPolicy, cePolicy, bedrockPolicy],
      tracing: cdk.aws_lambda.Tracing.ACTIVE,
    });

    // DynamoDB stream as event source
    asyncCostReportSender.addEventSource(new cdk.aws_lambda_event_sources.DynamoEventSource(costReportTable, {
      startingPosition: cdk.aws_lambda.StartingPosition.LATEST,
      batchSize: 5,
      retryAttempts: 2,
    }));

    // Pre-signup Lambda for Cognito User Pool
    const preSignUpLambda = new cdk.aws_lambda.Function(this, 'PreSignUpLambda', {
      functionName: 'PreSignUpLambda',
      description: 'Lambda function for Cognito User Pool pre-signup trigger',
      runtime: cdk.aws_lambda.Runtime.NODEJS_22_X,
      handler: 'pre-signup.handler',
      code: cdk.aws_lambda.Code.fromAsset('src/lambdas'),
      timeout: cdk.Duration.seconds(10),
      memorySize: 128,
    });

    // User Pool and Cognito Authorizer for API Gateway
    const userPool = new cdk.aws_cognito.UserPool(this, 'UserPool', {
      userPoolName: 'CostOpsUserPool',
      selfSignUpEnabled: true,
      signInAliases: { email: true },
      lambdaTriggers: {
        preSignUp: preSignUpLambda,
      },
    });

    // Cognito User Pool Domain
    new cdk.aws_cognito.UserPoolDomain(this, 'UserPoolDomain', {
      userPool,
      cognitoDomain: {
        domainPrefix: 'costops',
      },
    });

    new cdk.aws_cognito.UserPoolClient(this, 'UserPoolClient', {
      userPoolClientName: 'CostOpsUserPoolClient',
      userPool,
      oAuth: {
        flows: {
          authorizationCodeGrant: true,
          implicitCodeGrant: true,
        },
        callbackUrls: ['http://localhost:3000', 'https://costops.learnmorecloud.com'],
        defaultRedirectUri: 'https://costops.learnmorecloud.com',
        logoutUrls: ['https://costops.learnmorecloud.com'],
        scopes: [cdk.aws_cognito.OAuthScope.OPENID, cdk.aws_cognito.OAuthScope.EMAIL],
      },
      supportedIdentityProviders: [cdk.aws_cognito.UserPoolClientIdentityProvider.COGNITO],
      authFlows: {
        userPassword: true,
        custom: true,
        userSrp: true,
      },
    });

    const authorizer = new cdk.aws_apigateway.CognitoUserPoolsAuthorizer(this, 'APIAuthorizer', {
      cognitoUserPools: [userPool],
    });

    // === API Gateway ===
    const api = new cdk.aws_apigateway.RestApi(this, 'chatopsApi', {
      restApiName: 'api-devops-chatops',
      description: 'API for DevOps ChatOps',
      defaultCorsPreflightOptions: {
        allowOrigins: ["*"],
        allowHeaders: ["Content-Type", "X-Amz-Date", "Authorization", "X-Api-Key", "X-Amz-Security-Token"],
        allowMethods: ["OPTIONS", "POST"],
      },
    });
    const chatResource = api.root.addResource('chat');

    chatResource.addMethod('POST', new cdk.aws_apigateway.LambdaIntegration(lambdaFunction), {
      authorizer,
      authorizationType: cdk.aws_apigateway.AuthorizationType.COGNITO,
    });

    // === Outputs ===
    new cdk.CfnOutput(this, 'CFDistributionDomainName', {
      value: distribution.distributionDomainName,
      description: 'CloudFront Distribution Domain Name for reports',
    });
    new cdk.CfnOutput(this, 'APIEndpoint', {
      value: api.url,
      description: 'API Gateway endpoint for DevOps ChatOps',
    });
  }
}
