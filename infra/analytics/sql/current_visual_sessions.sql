WITH ranked AS (
  SELECT entity_id, opened_at, phase, critical, safety_concern, image_analysis_ready,
         event_time, sequence_number, is_deleted,
         row_number() OVER (
           PARTITION BY entity_id
           ORDER BY event_time DESC, try_cast(sequence_number AS DECIMAL(38, 0)) DESC
         ) AS event_rank
  FROM overdrive.ticket_events
  WHERE entity_type = 'visual_session'
)
SELECT entity_id, opened_at, phase, critical, safety_concern, image_analysis_ready,
       event_time AS last_event_time
FROM ranked
WHERE event_rank = 1 AND is_deleted = false