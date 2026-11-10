SELECT substr(advisor_hash, 1, 8) AS advisor_ref,
       count(*) AS active_tickets,
       count_if(priority IN ('HIGH', 'CRITICAL')) AS high_priority_active,
       count_if(status = 'WAITING_FOR_CUSTOMER') AS waiting_for_customer
FROM overdrive.current_tickets
WHERE assigned = true
  AND advisor_hash IS NOT NULL
  AND status IN ('ASSIGNED', 'IN_PROGRESS', 'WAITING_FOR_CUSTOMER')
GROUP BY substr(advisor_hash, 1, 8)