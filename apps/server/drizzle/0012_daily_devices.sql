-- T-029. Objectif quotidien : un compteur par appareil et par jour (G-Counter, fusion par maximum).
ALTER TABLE flaw.daily_progress ADD COLUMN device_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000';
--> statement-breakpoint
ALTER TABLE flaw.daily_progress DROP CONSTRAINT daily_progress_owner_day_uidx;
--> statement-breakpoint
ALTER TABLE flaw.daily_progress ADD CONSTRAINT daily_progress_owner_day_device_uidx UNIQUE (owner_id, day, device_id);
