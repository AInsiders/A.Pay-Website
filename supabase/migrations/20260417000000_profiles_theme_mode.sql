alter table public.profiles
  add column if not exists theme_mode text not null default 'dark';

-- Keep existing rows valid.
update public.profiles
  set theme_mode = 'dark'
where theme_mode is null;
