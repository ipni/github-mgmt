terraform {
  backend "s3" {
    region         = "us-east-2"
    bucket         = "sti-dev-terraform-state"
    key            = "terraform.tfstate"
    workspace_key_prefix = "github-mgmt"
    dynamodb_table = "ipni_gh_mgmt_lock"
  }
}
