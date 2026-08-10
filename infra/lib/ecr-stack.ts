import { Stack, StackProps, RemovalPolicy } from "aws-cdk-lib";
import { Construct } from "constructs";
import * as ecr from "aws-cdk-lib/aws-ecr";

interface EcrStackProps extends StackProps {
  namePrefix: string;
}

// Deployed before ServicesStack so images can be built and pushed here
// first — ServicesStack's ECS services would otherwise fail to start
// looking for a "latest" image tag that doesn't exist yet.
export class EcrStack extends Stack {
  readonly agentServerRepo: ecr.Repository;
  readonly dashboardRepo: ecr.Repository;

  constructor(scope: Construct, id: string, props: EcrStackProps) {
    super(scope, id, props);
    const { namePrefix } = props;

    // removalPolicy + emptyOnDelete so `cdk destroy` doesn't get blocked by
    // (or leave orphaned) images in a repo that still has pushed content —
    // this is meant to be torn down and redeployed freely, not kept forever.
    this.agentServerRepo = new ecr.Repository(this, "AgentServerRepo", {
      repositoryName: `${namePrefix}/agent-server`,
      imageScanOnPush: true,
      removalPolicy: RemovalPolicy.DESTROY,
      emptyOnDelete: true,
    });
    this.dashboardRepo = new ecr.Repository(this, "DashboardRepo", {
      repositoryName: `${namePrefix}/dashboard`,
      imageScanOnPush: true,
      removalPolicy: RemovalPolicy.DESTROY,
      emptyOnDelete: true,
    });
  }
}
