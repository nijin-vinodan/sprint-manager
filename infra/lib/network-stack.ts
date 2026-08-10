import { Stack, StackProps } from "aws-cdk-lib";
import { Construct } from "constructs";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";

interface NetworkStackProps extends StackProps {
  namePrefix: string;
}

export class NetworkStack extends Stack {
  readonly vpc: ec2.Vpc;
  readonly cluster: ecs.Cluster;

  constructor(scope: Construct, id: string, props: NetworkStackProps) {
    super(scope, id, props);
    const { namePrefix } = props;

    // No RDS (Postgres is external, on Neon) and no other private-only
    // resource, so tasks run in public subnets with a locked-down security
    // group instead of paying for a NAT Gateway just for outbound internet
    // access (Jira/GitHub/Anthropic/Neon).
    this.vpc = new ec2.Vpc(this, "Vpc", {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [
        { name: "public", subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
      ],
    });

    this.cluster = new ecs.Cluster(this, "Cluster", {
      vpc: this.vpc,
      clusterName: namePrefix,
      containerInsights: true,
    });
  }
}
