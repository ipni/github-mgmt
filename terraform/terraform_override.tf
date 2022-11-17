terraform {
  backend "s3" {
    region         = "us-east-2"
    bucket         = "sti-dev-terraform-state"
    key            = "ipni/github-mgmt/terraform.tfstate"
    dynamodb_table = "ipni_gh_mgmt_lock"
  }
}
