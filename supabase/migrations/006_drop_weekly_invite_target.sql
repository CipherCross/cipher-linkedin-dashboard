-- Per-machine config targets were dropped before anyone set one — nobody
-- wants to maintain goals in three notebook config files. The warm-up chart
-- keeps the static 100-200/week LinkedIn safe band instead.
alter table instances drop column if exists weekly_invite_target;
