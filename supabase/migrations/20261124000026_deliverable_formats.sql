-- Deliverables the client uses directly: PDF documents, Excel-ready spreadsheets, SVG visuals (plus websites as HTML).
alter table public.deliverables drop constraint if exists deliverables_format_check;
alter table public.deliverables add constraint deliverables_format_check
  check (format in ('markdown','code','json','text','html','csv','pdf','spreadsheet','svg'));
