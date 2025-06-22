#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { LambdaHackathonStack } from '../lib/lambda-hackathon-stack';

const app = new cdk.App();
new LambdaHackathonStack(app, 'LambdaHackathonStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
  description: 'AWS Lambda Hackathon Stack',
});