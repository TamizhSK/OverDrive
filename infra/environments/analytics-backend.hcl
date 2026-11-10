# Separate remote state for the analytics root. The analytics root is the only Terraform state.
bucket         = "servicecare-tfstate-ACCOUNT_ID-eu-north-1"
key            = "servicecare/analytics/dev/terraform.tfstate"
region         = "eu-north-1"
dynamodb_table = "servicecare-terraform-locks"
encrypt        = true