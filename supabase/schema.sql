-- Flexi Warranty Check: สคริปต์สร้างฐานข้อมูลบน Supabase
-- วิธีใช้: Supabase Dashboard > SQL Editor > New query > วางทั้งไฟล์ > Run
-- รันซ้ำได้ ไม่ทำให้ข้อมูลเดิมหาย

-- 1) ที่เก็บข้อมูล ----------------------------------------------------------
-- collection 'units'    = สินค้าหนึ่งชิ้นต่อหนึ่ง Serial (id = Serial ที่แปลงแล้ว)
-- collection 'settings' = ค่าตั้งต้น เช่น ระยะประกันตามประเภท, ประเภทที่เพิ่มเอง
create table if not exists public.docs (
  collection text        not null,
  id         text        not null,
  data       jsonb       not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (collection, id)
);

create index if not exists docs_units_serial_idx
  on public.docs ((data ->> 'serial'))
  where collection = 'units';

create or replace function public.docs_touch()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists docs_touch_trg on public.docs;
create trigger docs_touch_trg before update on public.docs
  for each row execute function public.docs_touch();

-- 2) สิทธิ์: เฉพาะพนักงานที่ล็อกอินเท่านั้นที่อ่านและเขียนตาราง docs ได้ ------
-- คนทั่วไป (anon) เข้าตารางโดยตรงไม่ได้เลย ต้องผ่านฟังก์ชัน check_warranty ด้านล่าง
alter table public.docs enable row level security;

drop policy if exists staff_all on public.docs;
create policy staff_all on public.docs
  for all to authenticated
  using (true) with check (true);

revoke all on public.docs from anon;
grant select, insert, update, delete on public.docs to authenticated;

-- 3) บันทึกการเช็คสาธารณะ ไว้จำกัดจำนวนครั้ง ---------------------------------
create table if not exists public.check_log (
  id      bigserial primary key,
  ip_hash text        not null,
  at      timestamptz not null default now()
);
create index if not exists check_log_ip_at_idx on public.check_log (ip_hash, at);

alter table public.check_log enable row level security;
revoke all on public.check_log from anon, authenticated;

-- 4) ฟังก์ชันเช็คประกันสำหรับลูกค้า ----------------------------------------
-- คืนเฉพาะ: ชื่อสินค้า ยี่ห้อ ประเภท สถานะ ระยะประกัน และวันสิ้นสุด
-- ไม่คืนชื่อลูกค้า เบอร์โทร เลขที่ใบขาย ผู้จำหน่าย หรือราคา
-- จำกัด 30 ครั้ง ต่อ 10 นาที ต่อที่อยู่ IP (ลดการสุ่มเดา Serial แต่กันไม่ได้ทั้งหมด)
create or replace function public.check_warranty(p_serial text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_serial  text;
  v_ip      text;
  v_hash    text;
  v_recent  int;
  v_row     jsonb;
  v_end     date;
begin
  v_serial := upper(regexp_replace(coalesce(p_serial, ''), '\s', '', 'g'));
  if length(v_serial) < 4 or length(v_serial) > 64 then
    return jsonb_build_object('ok', false, 'error', 'invalid');
  end if;

  begin
    v_ip := split_part(
      coalesce((current_setting('request.headers', true))::jsonb ->> 'x-forwarded-for', ''),
      ',', 1);
  exception when others then
    v_ip := '';
  end;
  v_hash := md5(coalesce(nullif(trim(v_ip), ''), 'unknown'));

  delete from public.check_log where at < now() - interval '1 day';

  select count(*) into v_recent
    from public.check_log
   where ip_hash = v_hash and at > now() - interval '10 minutes';

  if v_recent >= 30 then
    return jsonb_build_object('ok', false, 'error', 'rate_limited');
  end if;

  insert into public.check_log (ip_hash) values (v_hash);

  select data into v_row
    from public.docs
   where collection = 'units' and data ->> 'serial' = v_serial
   limit 1;

  if v_row is null then
    return jsonb_build_object('ok', true, 'found', false);
  end if;

  begin
    v_end := nullif(v_row ->> 'warrantyEnd', '')::date;
  exception when others then
    v_end := null;
  end;

  return jsonb_build_object(
    'ok', true,
    'found', true,
    'serial', v_row ->> 'serial',
    'product', v_row ->> 'product',
    'brand', v_row ->> 'brand',
    'category', v_row ->> 'category',
    'sold', (v_row ->> 'status') = 'sold',
    'warrantyMonths', v_row -> 'warrantyMonths',
    'warrantyEnd', v_end,
    'today', (now() at time zone 'Asia/Bangkok')::date
  );
end;
$$;

revoke all on function public.check_warranty(text) from public;
grant execute on function public.check_warranty(text) to anon, authenticated;

-- 5) เปิดอัปเดตสดให้พนักงาน (หลายเครื่องเห็นสต็อกตรงกัน) -------------------
do $$
begin
  alter publication supabase_realtime add table public.docs;
exception
  when duplicate_object then null;
  when undefined_object then null;
end;
$$;
