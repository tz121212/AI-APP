CREATE TABLE public.schedule_records (
  owner_id text NOT NULL DEFAULT auth.uid(),
  date date NOT NULL,
  person text NOT NULL CHECK (person IN ('军', '震')),
  off boolean NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  client_updated_at bigint NOT NULL DEFAULT 0,
  device_id text NOT NULL DEFAULT '',
  PRIMARY KEY (owner_id, date, person)
);

GRANT SELECT, INSERT, UPDATE ON public.schedule_records TO authenticated;

ALTER TABLE public.schedule_records ENABLE ROW LEVEL SECURITY;

CREATE POLICY schedule_records_shared_access ON public.schedule_records
  FOR ALL TO authenticated
  USING (owner_id = auth.uid())
  WITH CHECK (owner_id = auth.uid());

CREATE OR REPLACE FUNCTION public.set_schedule_records_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE TRIGGER schedule_records_updated_at
  BEFORE INSERT OR UPDATE ON public.schedule_records
  FOR EACH ROW EXECUTE FUNCTION public.set_schedule_records_updated_at();
