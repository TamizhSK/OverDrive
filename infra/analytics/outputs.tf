output "analytics_bucket" {
  value = aws_s3_bucket.analytics.bucket
}

output "firehose_stream_name" {
  value = aws_kinesis_firehose_delivery_stream.analytics.name
}

output "glue_database" {
  value = aws_glue_catalog_database.overdrive.name
}

output "glue_events_table" {
  value = aws_glue_catalog_table.events.name
}

output "athena_workgroup" {
  value = aws_athena_workgroup.analytics.name
}

