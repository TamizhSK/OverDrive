variable "aws_region" {
  type    = string
  default = "us-east-1"
}

variable "environment" {
  type    = string
  default = "dev"
  validation {
    condition     = contains(["dev", "test", "prod"], var.environment)
    error_message = "Use dev, test, or prod."
  }
}

variable "backend_stack_name" {
  type    = string
  default = "servicecare-backend"
}

variable "visual_support_stack_name" {
  type    = string
  default = "servicecare-visual-support"
}

variable "quicksight_data_source_id" {
  type        = string
  default     = "a14ef327-c6f6-4469-bbf2-4d15195ebd3e"
  description = "Existing QuickSight Athena data source ID to import and reuse."
}

variable "quicksight_data_source_name" {
  type    = string
  default = "overdrive"
}

variable "query_result_retention_days" {
  type    = number
  default = 30
  validation {
    condition     = var.query_result_retention_days >= 1 && var.query_result_retention_days <= 365
    error_message = "Query results must be retained for 1 to 365 days."
  }
}
variable "visual_sessions_table_name" {
  description = "Visual-support sessions table used when the stack has no SessionsTableName output."
  type        = string
  default     = "servicecare-visual-support-Sessions-1I66OV3TJ9XLZ"
}
