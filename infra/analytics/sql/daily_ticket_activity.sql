WITH ranked AS (
  SELECT event_id, event_date, event_time, sequence_number,
         ticket_created, ticket_resolved, is_deleted,
         row_number() OVER (
           PARTITION BY event_id
           ORDER BY event_time DESC, try_cast(sequence_number AS DECIMAL(38, 0)) DESC
         ) AS event_rank
  FROM overdrive.ticket_events
  WHERE entity_type = 'ticket'
    AND event_date >= date_format(current_date - interval '90' day, '%Y-%m-%d')
)
SELECT date_parse(event_date, '%Y-%m-%d') AS event_date,
       count_if(ticket_created = true) AS tickets_opened,
       count_if(ticket_resolved = true) AS tickets_resolved
FROM ranked
WHERE event_rank = 1 AND is_deleted = false
GROUP BY date_parse(event_date, '%Y-%m-%d')