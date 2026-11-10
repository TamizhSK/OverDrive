CREATE OR REPLACE VIEW overdrive.current_tickets AS
SELECT
  entity_id,
  status,
  priority,
  category,
  source,
  assigned,
  advisor_hash,
  opened_at,
  event_time AS last_event_time,
  date_diff('hour', from_iso8601_timestamp(opened_at), current_timestamp) AS age_hours
FROM (
  SELECT
    entity_id,
    status,
    priority,
    category,
    source,
    assigned,
    advisor_hash,
    opened_at,
    event_time,
    is_deleted,
    row_number() OVER (
      PARTITION BY entity_id
      ORDER BY event_time DESC, try_cast(sequence_number AS DECIMAL(38, 0)) DESC
    ) AS event_rank
  FROM overdrive.ticket_events
  WHERE entity_type = 'ticket'
)
WHERE event_rank = 1 AND is_deleted = false;

CREATE OR REPLACE VIEW overdrive.current_interactions AS
SELECT entity_id, resolved, event_time AS last_event_time
FROM (
  SELECT
    entity_id,
    resolved,
    event_time,
    is_deleted,
    row_number() OVER (
      PARTITION BY entity_id
      ORDER BY event_time DESC, try_cast(sequence_number AS DECIMAL(38, 0)) DESC
    ) AS event_rank
  FROM overdrive.ticket_events
  WHERE entity_type = 'assistant_interaction'
)
WHERE event_rank = 1 AND is_deleted = false;

CREATE OR REPLACE VIEW overdrive.current_visual_sessions AS
SELECT entity_id, phase, critical, safety_concern, image_analysis_ready, event_time AS last_event_time
FROM (
  SELECT
    entity_id,
    phase,
    critical,
    safety_concern,
    image_analysis_ready,
    event_time,
    is_deleted,
    row_number() OVER (
      PARTITION BY entity_id
      ORDER BY event_time DESC, try_cast(sequence_number AS DECIMAL(38, 0)) DESC
    ) AS event_rank
  FROM overdrive.ticket_events
  WHERE entity_type = 'visual_session'
)
WHERE event_rank = 1 AND is_deleted = false;

CREATE OR REPLACE VIEW overdrive.advisor_workload AS
SELECT
  substr(advisor_hash, 1, 8) AS advisor_ref,
  count(*) AS active_tickets,
  count_if(priority IN ('HIGH', 'CRITICAL')) AS high_priority_active,
  count_if(status = 'WAITING_FOR_CUSTOMER') AS waiting_for_customer
FROM overdrive.current_tickets
WHERE assigned = true
  AND advisor_hash IS NOT NULL
  AND status IN ('ASSIGNED', 'IN_PROGRESS', 'WAITING_FOR_CUSTOMER')
GROUP BY substr(advisor_hash, 1, 8);

CREATE OR REPLACE VIEW overdrive.daily_ticket_activity AS
SELECT
  date_parse(event_date, '%Y-%m-%d') AS event_date,
  count_if(ticket_created = true) AS tickets_opened,
  count_if(ticket_resolved = true) AS tickets_resolved
FROM (
  SELECT
    event_id,
    event_date,
    ticket_created,
    ticket_resolved,
    is_deleted,
    row_number() OVER (
      PARTITION BY event_id
      ORDER BY event_time DESC, try_cast(sequence_number AS DECIMAL(38, 0)) DESC
    ) AS event_rank
  FROM overdrive.ticket_events
  WHERE entity_type = 'ticket'
    AND event_date >= date_format(current_date - interval '90' day, '%Y-%m-%d')
)
WHERE event_rank = 1 AND is_deleted = false
GROUP BY date_parse(event_date, '%Y-%m-%d');

CREATE OR REPLACE VIEW overdrive.advisor_kpis AS
SELECT 'Open tickets' AS metric, cast(count_if(status IN ('OPEN', 'ASSIGNED', 'IN_PROGRESS', 'WAITING_FOR_CUSTOMER')) AS bigint) AS metric_value
FROM overdrive.current_tickets
UNION ALL
SELECT 'Unassigned open tickets', cast(count_if(assigned = false AND status IN ('OPEN', 'ASSIGNED', 'IN_PROGRESS', 'WAITING_FOR_CUSTOMER')) AS bigint)
FROM overdrive.current_tickets
UNION ALL
SELECT 'High priority open tickets', cast(count_if(priority IN ('HIGH', 'CRITICAL') AND status IN ('OPEN', 'ASSIGNED', 'IN_PROGRESS', 'WAITING_FOR_CUSTOMER')) AS bigint)
FROM overdrive.current_tickets
UNION ALL
SELECT 'Open tickets older than 72h', cast(count_if(age_hours > 72 AND status IN ('OPEN', 'ASSIGNED', 'IN_PROGRESS', 'WAITING_FOR_CUSTOMER')) AS bigint)
FROM overdrive.current_tickets
UNION ALL
SELECT 'Assistant interactions (90d)', cast(count_if(last_event_time >= cast(current_timestamp - interval '90' day AS varchar)) AS bigint)
FROM overdrive.current_interactions
UNION ALL
SELECT 'Completed photo analyses (90d)', cast(count_if(image_analysis_ready = true) AS bigint)
FROM overdrive.current_visual_sessions
UNION ALL
SELECT 'Safety photo reviews', cast(count_if((critical = true OR safety_concern = true) AND phase <> 'RESOLVED') AS bigint)
FROM overdrive.current_visual_sessions;