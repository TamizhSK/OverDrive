SELECT 'Open tickets' AS metric,
       cast(count_if(status IN ('OPEN', 'ASSIGNED', 'IN_PROGRESS', 'WAITING_FOR_CUSTOMER')) AS bigint) AS metric_value
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
SELECT 'Assistant interactions (90d)', cast(count_if(try(from_iso8601_timestamp(opened_at)) >= current_timestamp - interval '90' day) AS bigint)
FROM overdrive.current_interactions
UNION ALL
SELECT 'Completed photo analyses (90d)', cast(count_if(image_analysis_ready = true AND try(from_iso8601_timestamp(opened_at)) >= current_timestamp - interval '90' day) AS bigint)
FROM overdrive.current_visual_sessions
UNION ALL
SELECT 'Safety photo reviews', cast(count_if((critical = true OR safety_concern = true) AND phase <> 'RESOLVED') AS bigint)
FROM overdrive.current_visual_sessions