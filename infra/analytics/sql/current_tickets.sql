WITH ranked AS (
  SELECT entity_id, status, priority, category, source, assigned, advisor_hash,
         opened_at, event_time, sequence_number, is_deleted,
         row_number() OVER (
           PARTITION BY entity_id
           ORDER BY event_time DESC, try_cast(sequence_number AS DECIMAL(38, 0)) DESC
         ) AS event_rank
  FROM overdrive.ticket_events
  WHERE entity_type = 'ticket'
)
SELECT entity_id, status, priority, category, source, assigned, advisor_hash,
       opened_at, event_time AS last_event_time,
       date_diff('hour', try(from_iso8601_timestamp(opened_at)), current_timestamp) AS age_hours
FROM ranked
WHERE event_rank = 1 AND is_deleted = false