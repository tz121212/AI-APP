WITH merged AS (
  SELECT DISTINCT ON (date, person)
    date,
    person,
    off,
    client_updated_at,
    device_id
  FROM public.schedule_records
  ORDER BY date, person, updated_at DESC, client_updated_at DESC, device_id DESC
)
INSERT INTO public.schedule_records (
  owner_id,
  date,
  person,
  off,
  client_updated_at,
  device_id
)
SELECT
  'daily-assistant-internal-shared',
  date,
  person,
  off,
  client_updated_at,
  device_id
FROM merged
ON CONFLICT (owner_id, date, person) DO UPDATE SET
  off = EXCLUDED.off,
  client_updated_at = EXCLUDED.client_updated_at,
  device_id = EXCLUDED.device_id;

-- Preserve legacy account rows; the new policy exposes only the shared copy.
GRANT SELECT, INSERT, UPDATE ON public.schedule_records TO anon, authenticated;

DROP POLICY IF EXISTS schedule_records_shared_access ON public.schedule_records;

CREATE POLICY schedule_records_shared_access ON public.schedule_records
  FOR ALL TO anon, authenticated
  USING (owner_id = 'daily-assistant-internal-shared')
  WITH CHECK (owner_id = 'daily-assistant-internal-shared');
