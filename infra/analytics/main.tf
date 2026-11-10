data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}

data "aws_cloudformation_stack" "backend" {
  name = var.backend_stack_name
}

data "aws_cloudformation_stack" "visual_support" {
  name = var.visual_support_stack_name
}

data "aws_dynamodb_table" "tickets" {
  name = data.aws_cloudformation_stack.backend.outputs["TicketsTable"]
}

data "aws_dynamodb_table" "interactions" {
  name = data.aws_cloudformation_stack.backend.outputs["InteractionsTable"]
}

data "aws_dynamodb_table" "visual_sessions" {
  name = try(data.aws_cloudformation_stack.visual_support.outputs["SessionsTableName"], var.visual_sessions_table_name)
}

locals {
  event_columns = [
    { name = "schema_version", type = "int" },
    { name = "entity_type", type = "string" },
    { name = "entity_id", type = "string" },
    { name = "event_id", type = "string" },
    { name = "event_type", type = "string" },
    { name = "event_time", type = "string" },
    { name = "event_date", type = "string" },
    { name = "sequence_number", type = "string" },
    { name = "opened_at", type = "string" },
    { name = "status_before", type = "string" },
    { name = "status_after", type = "string" },
    { name = "status", type = "string" },
    { name = "priority_before", type = "string" },
    { name = "priority_after", type = "string" },
    { name = "priority", type = "string" },
    { name = "category", type = "string" },
    { name = "source", type = "string" },
    { name = "assigned_before", type = "boolean" },
    { name = "assigned_after", type = "boolean" },
    { name = "assigned", type = "boolean" },
    { name = "advisor_id_hash_before", type = "string" },
    { name = "advisor_id_hash_after", type = "string" },
    { name = "advisor_hash", type = "string" },
    { name = "resolved_before", type = "boolean" },
    { name = "resolved_after", type = "boolean" },
    { name = "resolved", type = "boolean" },
    { name = "phase_before", type = "string" },
    { name = "phase_after", type = "string" },
    { name = "phase", type = "string" },
    { name = "critical", type = "boolean" },
    { name = "safety_concern", type = "boolean" },
    { name = "image_analysis_ready", type = "boolean" },
    { name = "ticket_created", type = "boolean" },
    { name = "ticket_resolved", type = "boolean" },
    { name = "advisor_assigned", type = "boolean" },
    { name = "is_deleted", type = "boolean" },
  ]
  event_data_columns = [
    for column in local.event_columns : column
    if !contains(["entity_type", "event_date"], column.name)
  ]
}

data "archive_file" "analytics_consumer" {
  type        = "zip"
  source_file = "${path.module}/../../backend/dist/analytics/index.cjs"
  output_path = "${path.module}/.terraform/analytics-consumer.zip"
}

resource "aws_s3_bucket" "analytics" {
  bucket        = "servicecare-analytics-${data.aws_caller_identity.current.account_id}-${var.aws_region}"
  force_destroy = false

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_public_access_block" "analytics" {
  bucket                  = aws_s3_bucket.analytics.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "analytics" {
  bucket = aws_s3_bucket.analytics.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_versioning" "analytics" {
  bucket = aws_s3_bucket.analytics.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "analytics" {
  bucket = aws_s3_bucket.analytics.id

  rule {
    id     = "expire-failed-deliveries"
    status = "Enabled"
    filter { prefix = "errors/" }
    expiration { days = 7 }
    noncurrent_version_expiration { noncurrent_days = 7 }
  }

  rule {
    id     = "expire-event-history"
    status = "Enabled"
    filter { prefix = "events/" }
    expiration { days = 365 }
    noncurrent_version_expiration { noncurrent_days = 365 }
  }

  rule {
    id     = "expire-athena-results"
    status = "Enabled"
    filter { prefix = "query-results/" }
    expiration { days = var.query_result_retention_days }
    noncurrent_version_expiration { noncurrent_days = var.query_result_retention_days }
  }

  rule {
    id     = "abort-incomplete-multipart-uploads"
    status = "Enabled"
    filter {}
    abort_incomplete_multipart_upload { days_after_initiation = 1 }
  }
}

resource "aws_s3_bucket_policy" "analytics" {
  bucket = aws_s3_bucket.analytics.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "DenyInsecureTransport"
      Effect    = "Deny"
      Principal = "*"
      Action    = "s3:*"
      Resource  = [aws_s3_bucket.analytics.arn, "${aws_s3_bucket.analytics.arn}/*"]
      Condition = { Bool = { "aws:SecureTransport" = "false" } }
    }]
  })
}

resource "aws_sqs_queue" "failed_batches" {
  name                       = "servicecare-analytics-stream-failures"
  message_retention_seconds  = 1209600
  sqs_managed_sse_enabled    = true
  visibility_timeout_seconds = 180
}

resource "aws_cloudwatch_log_group" "consumer" {
  name              = "/aws/lambda/servicecare-analytics-consumer"
  retention_in_days = 30
}

resource "aws_cloudwatch_log_group" "firehose" {
  name              = "/aws/kinesisfirehose/servicecare-analytics-to-s3"
  retention_in_days = 30
}

data "aws_iam_policy_document" "lambda_trust" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "consumer" {
  name               = "servicecare-analytics-consumer"
  assume_role_policy = data.aws_iam_policy_document.lambda_trust.json
}

resource "aws_iam_role_policy_attachment" "consumer_logs" {
  role       = aws_iam_role.consumer.name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

data "aws_iam_policy_document" "consumer" {
  statement {
    sid       = "ReadOnlyConfiguredDynamoStreams"
    effect    = "Allow"
    actions   = ["dynamodb:DescribeStream", "dynamodb:GetRecords", "dynamodb:GetShardIterator", "dynamodb:ListStreams"]
    resources = [data.aws_dynamodb_table.tickets.stream_arn, data.aws_dynamodb_table.interactions.stream_arn, data.aws_dynamodb_table.visual_sessions.stream_arn]
  }

  statement {
    sid       = "BatchWriteSanitizedEvents"
    effect    = "Allow"
    actions   = ["firehose:PutRecordBatch"]
    resources = [aws_kinesis_firehose_delivery_stream.analytics.arn]
  }

  statement {
    sid       = "SendFailedBatchesToRecoveryQueue"
    effect    = "Allow"
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.failed_batches.arn]
  }
}

resource "aws_iam_role_policy" "consumer" {
  name   = "servicecare-analytics-consumer"
  role   = aws_iam_role.consumer.id
  policy = data.aws_iam_policy_document.consumer.json
}

data "aws_iam_policy_document" "firehose_trust" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["firehose.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
    condition {
      test     = "ArnLike"
      variable = "aws:SourceArn"
      values   = ["arn:${data.aws_partition.current.partition}:firehose:${var.aws_region}:${data.aws_caller_identity.current.account_id}:deliverystream/servicecare-analytics-to-s3"]
    }
  }
}

resource "aws_iam_role" "firehose" {
  name               = "servicecare-analytics-firehose"
  assume_role_policy = data.aws_iam_policy_document.firehose_trust.json
}

data "aws_iam_policy_document" "firehose" {
  statement {
    sid       = "WriteAnalyticsObjects"
    effect    = "Allow"
    actions   = ["s3:AbortMultipartUpload", "s3:GetBucketLocation", "s3:GetObject", "s3:ListBucket", "s3:PutObject"]
    resources = [aws_s3_bucket.analytics.arn, "${aws_s3_bucket.analytics.arn}/*"]
  }

  statement {
    sid       = "ReadParquetSchema"
    effect    = "Allow"
    actions   = ["glue:GetTable", "glue:GetTableVersion", "glue:GetTableVersions"]
    resources = [
      "arn:${data.aws_partition.current.partition}:glue:${var.aws_region}:${data.aws_caller_identity.current.account_id}:catalog",
      "arn:${data.aws_partition.current.partition}:glue:${var.aws_region}:${data.aws_caller_identity.current.account_id}:database/${aws_glue_catalog_database.overdrive.name}",
      "arn:${data.aws_partition.current.partition}:glue:${var.aws_region}:${data.aws_caller_identity.current.account_id}:table/${aws_glue_catalog_database.overdrive.name}/${aws_glue_catalog_table.events.name}",
    ]
  }

  statement {
    sid       = "WriteFirehoseLogs"
    effect    = "Allow"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.firehose.arn}:*"]
  }
}

resource "aws_iam_role_policy" "firehose" {
  name   = "servicecare-analytics-firehose"
  role   = aws_iam_role.firehose.id
  policy = data.aws_iam_policy_document.firehose.json
}

resource "aws_kinesis_firehose_delivery_stream" "analytics" {
  name        = "servicecare-analytics-to-s3"
  destination = "extended_s3"

  extended_s3_configuration {
    role_arn            = aws_iam_role.firehose.arn
    bucket_arn          = aws_s3_bucket.analytics.arn
    prefix              = "events/entity_type=!{partitionKeyFromQuery:entity_type}/event_date=!{partitionKeyFromQuery:event_date}/"
    error_output_prefix = "errors/!{firehose:error-output-type}/year=!{timestamp:yyyy}/month=!{timestamp:MM}/day=!{timestamp:dd}/"
    buffering_size      = 64
    buffering_interval  = 300
    compression_format  = "UNCOMPRESSED"
    file_extension      = ".parquet"
    s3_backup_mode      = "Disabled"

    dynamic_partitioning_configuration {
      enabled        = true
      retry_duration = 300
    }

    processing_configuration {
      enabled = true
      processors {
        type = "MetadataExtraction"
        parameters {
          parameter_name  = "MetadataExtractionQuery"
          parameter_value = "{entity_type:.entity_type,event_date:.event_date}"
        }
        parameters {
          parameter_name  = "JsonParsingEngine"
          parameter_value = "JQ-1.6"
        }
      }
    }

    data_format_conversion_configuration {
      enabled = true
      input_format_configuration {
        deserializer {
          open_x_json_ser_de {
            case_insensitive                         = true
            convert_dots_in_json_keys_to_underscores = true
          }
        }
      }
      output_format_configuration {
        serializer {
          parquet_ser_de {
            compression = "SNAPPY"
          }
        }
      }
      schema_configuration {
        role_arn      = aws_iam_role.firehose.arn
        catalog_id    = data.aws_caller_identity.current.account_id
        region        = var.aws_region
        database_name = aws_glue_catalog_database.overdrive.name
        table_name    = aws_glue_catalog_table.events.name
        version_id    = "LATEST"
      }
    }

    cloudwatch_logging_options {
      enabled         = true
      log_group_name  = aws_cloudwatch_log_group.firehose.name
      log_stream_name = "S3Delivery"
    }
  }

  depends_on = [aws_iam_role_policy.firehose]
}

resource "aws_lambda_function" "consumer" {
  function_name    = "servicecare-analytics-consumer"
  description      = "Redacts DynamoDB change records and batches privacy-safe events to Firehose."
  role             = aws_iam_role.consumer.arn
  runtime          = "nodejs22.x"
  handler          = "index.handler"
  filename         = data.archive_file.analytics_consumer.output_path
  source_code_hash = data.archive_file.analytics_consumer.output_base64sha256
  memory_size      = 512
  timeout          = 30
  architectures    = ["x86_64"]

  environment {
    variables = {
      ANALYTICS_FIREHOSE_STREAM = aws_kinesis_firehose_delivery_stream.analytics.name
    }
  }

  depends_on = [aws_iam_role_policy_attachment.consumer_logs, aws_iam_role_policy.consumer]
}

resource "aws_lambda_event_source_mapping" "tickets" {
  event_source_arn                   = data.aws_dynamodb_table.tickets.stream_arn
  function_name                      = aws_lambda_function.consumer.arn
  starting_position                  = "TRIM_HORIZON"
  batch_size                         = 100
  maximum_batching_window_in_seconds = 1
  parallelization_factor             = 1
  maximum_retry_attempts             = 10
  maximum_record_age_in_seconds      = 3600
  bisect_batch_on_function_error     = true
  function_response_types            = ["ReportBatchItemFailures"]
  destination_config {
    on_failure { destination_arn = aws_sqs_queue.failed_batches.arn }
  }
}

resource "aws_lambda_event_source_mapping" "interactions" {
  event_source_arn                   = data.aws_dynamodb_table.interactions.stream_arn
  function_name                      = aws_lambda_function.consumer.arn
  starting_position                  = "TRIM_HORIZON"
  batch_size                         = 100
  maximum_batching_window_in_seconds = 1
  parallelization_factor             = 1
  maximum_retry_attempts             = 10
  maximum_record_age_in_seconds      = 3600
  bisect_batch_on_function_error     = true
  function_response_types            = ["ReportBatchItemFailures"]
  destination_config {
    on_failure { destination_arn = aws_sqs_queue.failed_batches.arn }
  }
}

resource "aws_lambda_event_source_mapping" "visual_sessions" {
  event_source_arn                   = data.aws_dynamodb_table.visual_sessions.stream_arn
  function_name                      = aws_lambda_function.consumer.arn
  starting_position                  = "TRIM_HORIZON"
  batch_size                         = 100
  maximum_batching_window_in_seconds = 1
  parallelization_factor             = 1
  maximum_retry_attempts             = 10
  maximum_record_age_in_seconds      = 3600
  bisect_batch_on_function_error     = true
  function_response_types            = ["ReportBatchItemFailures"]
  destination_config {
    on_failure { destination_arn = aws_sqs_queue.failed_batches.arn }
  }
}

resource "aws_glue_catalog_database" "overdrive" {
  name        = "overdrive"
  description = "Sanitized ServiceCare operational events for Athena and QuickSight."
}

resource "aws_glue_catalog_table" "events" {
  name          = "ticket_events"
  database_name = aws_glue_catalog_database.overdrive.name
  table_type    = "EXTERNAL_TABLE"

  parameters = {
    classification                    = "parquet"
    EXTERNAL                          = "TRUE"
    "parquet.compression"             = "SNAPPY"
    "projection.enabled"              = "true"
    "projection.entity_type.type"     = "enum"
    "projection.entity_type.values"   = "ticket,assistant_interaction,visual_session"
    "projection.event_date.type"      = "date"
    "projection.event_date.format"    = "yyyy-MM-dd"
    "projection.event_date.range"     = "2026-01-01,NOW"
    "projection.event_date.interval"  = "1"
    "projection.event_date.interval.unit" = "DAYS"
    "storage.location.template"       = "s3://${aws_s3_bucket.analytics.bucket}/events/entity_type=$${entity_type}/event_date=$${event_date}/"
  }

  partition_keys {
    name = "entity_type"
    type = "string"
  }
  partition_keys {
    name = "event_date"
    type = "string"
  }

  storage_descriptor {
    location      = "s3://${aws_s3_bucket.analytics.bucket}/events/"
    input_format  = "org.apache.hadoop.hive.ql.io.parquet.MapredParquetInputFormat"
    output_format = "org.apache.hadoop.hive.ql.io.parquet.MapredParquetOutputFormat"
    compressed    = true

    ser_de_info {
      name                  = "servicecare-analytics-events"
      serialization_library = "org.apache.hadoop.hive.ql.io.parquet.serde.ParquetHiveSerDe"
      parameters            = { "serialization.format" = "1" }
    }

    dynamic "columns" {
      for_each = local.event_data_columns
      content {
        name = columns.value.name
        type = columns.value.type
      }
    }
  }
}

resource "aws_athena_workgroup" "analytics" {
  name  = "servicecare-analytics"
  state = "ENABLED"

  configuration {
    enforce_workgroup_configuration    = true
    publish_cloudwatch_metrics_enabled = true
    result_configuration {
      output_location = "s3://${aws_s3_bucket.analytics.bucket}/query-results/"
      encryption_configuration {
        encryption_option = "SSE_S3"
      }
    }
  }
}

resource "aws_cloudwatch_metric_alarm" "consumer_errors" {
  alarm_name          = "servicecare-analytics-consumer-errors"
  alarm_description   = "DynamoDB stream analytics consumer invocation errors."
  namespace           = "AWS/Lambda"
  metric_name         = "Errors"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  dimensions          = { FunctionName = aws_lambda_function.consumer.function_name }
}

resource "aws_cloudwatch_metric_alarm" "consumer_iterator_age" {
  alarm_name          = "servicecare-analytics-stream-iterator-age"
  alarm_description   = "DynamoDB stream processing is more than two minutes behind."
  namespace           = "AWS/Lambda"
  metric_name         = "IteratorAge"
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 2
  threshold           = 120000
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  dimensions          = { FunctionName = aws_lambda_function.consumer.function_name }
}

resource "aws_cloudwatch_log_metric_filter" "firehose_errors" {
  name           = "servicecare-analytics-firehose-errors"
  log_group_name = aws_cloudwatch_log_group.firehose.name
  pattern        = "ERROR"
  metric_transformation {
    name      = "DeliveryErrors"
    namespace = "ServiceCare/Analytics"
    value     = "1"
  }
}

resource "aws_cloudwatch_metric_alarm" "firehose_errors" {
  alarm_name          = "servicecare-analytics-firehose-errors"
  alarm_description   = "Firehose logged an S3 delivery or conversion error."
  namespace           = "ServiceCare/Analytics"
  metric_name         = aws_cloudwatch_log_metric_filter.firehose_errors.metric_transformation[0].name
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
}

resource "aws_cloudwatch_metric_alarm" "failed_batches" {
  alarm_name          = "servicecare-analytics-failed-batches"
  alarm_description   = "One or more DynamoDB stream records reached the analytics recovery queue."
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateNumberOfMessagesVisible"
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  dimensions          = { QueueName = aws_sqs_queue.failed_batches.name }
}
