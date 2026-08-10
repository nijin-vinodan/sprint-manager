import {
  Stack,
  StackProps,
  Duration,
  CfnOutput,
  RemovalPolicy,
} from "aws-cdk-lib";
import { Construct } from "constructs";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as logs from "aws-cdk-lib/aws-logs";

interface ServicesStackProps extends StackProps {
  namePrefix: string;
  vpc: ec2.Vpc;
  cluster: ecs.Cluster;
  agentServerRepo: ecr.Repository;
  dashboardRepo: ecr.Repository;
}

const AGENT_SERVER_PORT = 8787;
const DASHBOARD_PORT = 3000;
const AGENT_SERVER_SERVICE_CONNECT_NAME = "agent-server";

export class ServicesStack extends Stack {
  constructor(scope: Construct, id: string, props: ServicesStackProps) {
    super(scope, id, props);

    const { namePrefix, vpc, cluster, agentServerRepo, dashboardRepo } = props;
    const serviceConnectNamespace = `${namePrefix}.local`;

    cluster.addDefaultCloudMapNamespace({
      name: serviceConnectNamespace,
    });

    // Created and populated with real values *before* this stack deploys
    // (see infra/README or the deploy runbook) via `aws secretsmanager
    // create-secret` — referenced here by name rather than created fresh, so
    // ECS tasks launch already pointing at real credentials instead of a
    // blank placeholder that would need a forced redeploy after the fact.
    const appSecrets = secretsmanager.Secret.fromSecretNameV2(
      this,
      "AppSecrets",
      `${namePrefix}/app-secrets`,
    );

    // --- Agent server (private-only, no public ALB target) ---
    // Runs in a public subnet (no NAT Gateway — nothing here needs one), but
    // its security group only allows inbound from the dashboard's SG, so it
    // has no reachable inbound path despite the public IP.

    const agentServerSg = new ec2.SecurityGroup(this, "AgentServerSg", {
      vpc,
      description: "Agent server Fargate tasks",
      allowAllOutbound: true,
    });

    const agentServerLogGroup = new logs.LogGroup(this, "AgentServerLogs", {
      logGroupName: `/${namePrefix}/agent-server`,
      retention: logs.RetentionDays.TWO_WEEKS,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const agentServerTaskDef = new ecs.FargateTaskDefinition(
      this,
      "AgentServerTaskDef",
      { cpu: 512, memoryLimitMiB: 1024 },
    );
    agentServerTaskDef.addContainer("agent-server", {
      image: ecs.ContainerImage.fromEcrRepository(agentServerRepo, "latest"),
      portMappings: [
        { name: "agent-server", containerPort: AGENT_SERVER_PORT },
      ],
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: "agent-server",
        logGroup: agentServerLogGroup,
      }),
      environment: {
        PORT: String(AGENT_SERVER_PORT),
        HOST: "0.0.0.0",
        JIRA_BASE_URL: process.env.JIRA_BASE_URL ?? "",
        JIRA_EMAIL: process.env.JIRA_EMAIL ?? "",
        JIRA_PROJECT_KEY: process.env.JIRA_PROJECT_KEY ?? "SMA",
        GITHUB_OWNER: process.env.GITHUB_OWNER ?? "",
        GITHUB_REPO: process.env.GITHUB_REPO ?? "",
        ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL ?? "",
        ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL ?? "",
        DIGEST_INTERVAL_MINUTES: process.env.DIGEST_INTERVAL_MINUTES ?? "20",
        K_NEIGHBORS: process.env.K_NEIGHBORS ?? "3",
        LOCK_STALE_SECONDS: process.env.LOCK_STALE_SECONDS ?? "600",
        STREAM_CHUNK_TTL_HOURS: process.env.STREAM_CHUNK_TTL_HOURS ?? "12",
      },
      secrets: {
        DATABASE_URL: ecs.Secret.fromSecretsManager(
          appSecrets,
          "DATABASE_URL",
        ),
        JIRA_API_TOKEN: ecs.Secret.fromSecretsManager(
          appSecrets,
          "JIRA_API_TOKEN",
        ),
        GITHUB_TOKEN: ecs.Secret.fromSecretsManager(
          appSecrets,
          "GITHUB_TOKEN",
        ),
        ANTHROPIC_AUTH_TOKEN: ecs.Secret.fromSecretsManager(
          appSecrets,
          "ANTHROPIC_AUTH_TOKEN",
        ),
        API_CLIENTS_JSON: ecs.Secret.fromSecretsManager(
          appSecrets,
          "API_CLIENTS_JSON",
        ),
      },
    });

    const agentServerService = new ecs.FargateService(
      this,
      "AgentServerService",
      {
        cluster,
        taskDefinition: agentServerTaskDef,
        desiredCount: 1,
        // minHealthyPercent defaults to 50%, which would round down to 0 for
        // a single-task service and take it fully offline mid-deploy.
        minHealthyPercent: 100,
        maxHealthyPercent: 200,
        circuitBreaker: { rollback: true },
        securityGroups: [agentServerSg],
        vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
        assignPublicIp: true,
        serviceConnectConfiguration: {
          namespace: serviceConnectNamespace,
          services: [
            {
              portMappingName: "agent-server",
              dnsName: AGENT_SERVER_SERVICE_CONNECT_NAME,
              port: AGENT_SERVER_PORT,
            },
          ],
        },
      },
    );

    // --- Dashboard (public, behind ALB) ---

    const dashboardSg = new ec2.SecurityGroup(this, "DashboardSg", {
      vpc,
      description: "Dashboard Fargate tasks",
      allowAllOutbound: true,
    });
    agentServerSg.addIngressRule(
      dashboardSg,
      ec2.Port.tcp(AGENT_SERVER_PORT),
      "Dashboard to agent-server (Service Connect)",
    );

    const dashboardLogGroup = new logs.LogGroup(this, "DashboardLogs", {
      logGroupName: `/${namePrefix}/dashboard`,
      retention: logs.RetentionDays.TWO_WEEKS,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const dashboardTaskDef = new ecs.FargateTaskDefinition(
      this,
      "DashboardTaskDef",
      { cpu: 512, memoryLimitMiB: 1024 },
    );
    dashboardTaskDef.addContainer("dashboard", {
      image: ecs.ContainerImage.fromEcrRepository(dashboardRepo, "latest"),
      portMappings: [{ containerPort: DASHBOARD_PORT }],
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: "dashboard",
        logGroup: dashboardLogGroup,
      }),
      environment: {
        PORT: String(DASHBOARD_PORT),
        AGENT_SERVER_URL: `http://${AGENT_SERVER_SERVICE_CONNECT_NAME}:${AGENT_SERVER_PORT}`,
        DIGEST_INTERVAL_MINUTES: process.env.DIGEST_INTERVAL_MINUTES ?? "20",
        RESOLUTION_COLLECTOR_INTERVAL_MINUTES:
          process.env.RESOLUTION_COLLECTOR_INTERVAL_MINUTES ?? "20",
      },
      secrets: {
        AGENT_SERVER_API_KEY: ecs.Secret.fromSecretsManager(
          appSecrets,
          "AGENT_SERVER_API_KEY",
        ),
      },
    });

    const dashboardService = new ecs.FargateService(this, "DashboardService", {
      cluster,
      taskDefinition: dashboardTaskDef,
      desiredCount: 2,
      circuitBreaker: { rollback: true },
      securityGroups: [dashboardSg],
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      assignPublicIp: true,
      serviceConnectConfiguration: { namespace: serviceConnectNamespace },
    });

    const albSg = new ec2.SecurityGroup(this, "AlbSg", {
      vpc,
      description: "Public ALB",
      allowAllOutbound: true,
    });
    albSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), "Public HTTP");
    dashboardSg.addIngressRule(
      albSg,
      ec2.Port.tcp(DASHBOARD_PORT),
      "ALB to dashboard",
    );

    const alb = new elbv2.ApplicationLoadBalancer(this, "Alb", {
      vpc,
      internetFacing: true,
      securityGroup: albSg,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
    });

    const listener = alb.addListener("HttpListener", {
      port: 80,
      open: false,
    });
    listener.addTargets("DashboardTarget", {
      port: DASHBOARD_PORT,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [dashboardService],
      healthCheck: { path: "/" },
      deregistrationDelay: Duration.seconds(30),
    });

    new CfnOutput(this, "AgentServerServiceName", {
      value: agentServerService.serviceName,
    });
    new CfnOutput(this, "AlbDnsName", { value: alb.loadBalancerDnsName });
  }
}
