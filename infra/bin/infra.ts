#!/usr/bin/env node
import "source-map-support/register";
import { App, Tags } from "aws-cdk-lib";
import { NetworkStack } from "../lib/network-stack";
import { EcrStack } from "../lib/ecr-stack";
import { ServicesStack } from "../lib/services-stack";

const app = new App();

// This is a shared ~1000-person sandbox account — "sprintmanager" alone
// isn't unique enough (stack names, ECR repo names, Secrets Manager secret
// names, log group names, and the ECS cluster name must all be unique per
// account+region, and someone else could easily pick the same generic
// name). Every resource name and the Project tag below carry this prefix.
const NAME_PREFIX = "nvinodan-sprintmanager";

// Lets cost be filtered to just this project once activated as a cost
// allocation tag (Billing console, or aws ce update-cost-allocation-tags-status) —
// this account has other unrelated workloads running in it.
Tags.of(app).add("Project", NAME_PREFIX);
// Owner identifies which resources are this deployment's, matching the
// createdby/owner convention other teams already use in this account.
Tags.of(app).add("Owner", "nvinodan@presidio.com");

const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION,
};

const network = new NetworkStack(app, `${NAME_PREFIX}-NetworkStack`, {
  env,
  namePrefix: NAME_PREFIX,
});
const ecr = new EcrStack(app, `${NAME_PREFIX}-EcrStack`, {
  env,
  namePrefix: NAME_PREFIX,
});
new ServicesStack(app, `${NAME_PREFIX}-ServicesStack`, {
  env,
  namePrefix: NAME_PREFIX,
  vpc: network.vpc,
  cluster: network.cluster,
  agentServerRepo: ecr.agentServerRepo,
  dashboardRepo: ecr.dashboardRepo,
});
