import { createDAVClient } from 'tsdav';
import { createClient } from '@supabase/supabase-js';

const TIMEZONE = 'Europe/London';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).send('Method not allowed');
    return;
  }

  if (req.headers['x-webhook-secret'] !== process.env.WEBHOOK_SECRET) {
    res.status(401).send('Unauthorized');
    return;
  }

  const record = req.body && req.body.record;

  if (!record || record.status !== 'booked' || record.calendar_synced) {
    res.status(200).json({ skipped: true });
    return;
  }

  try {
    const client = await createDAVClient({
      serverUrl: 'https://caldav.icloud.com',
      credentials: {
        username: process.env.APPLE_ID,
        password: process.env.APPLE_APP_PASSWORD,
      },
      authMethod: 'Basic',
      defaultAccountType: 'caldav',
    });

    const calendars = await client.fetchCalendars();
    if (!calendars.length) {
      throw new Error('No calendars found for this Apple ID');
    }
    const calendar = calendars[0];

    const ics = buildICS(record);

    await client.createCalendarObject({
      calendar,
      filename: `booking-${record.id}.ics`,
      iCalString: ics,
    });

    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const { error } = await supabase
      .from('slots')
      .update({ calendar_synced: true })
      .eq('id', record.id);

    if (error) throw error;

    res.status(200).json({ synced: true });
  } catch (err) {
    console.error('Calendar sync failed:', err);
    res.status(500).json({ error: String(err && err.message ? err.message : err) });
  }
}

function toICSDateTime(date, time) {
  return `${date.replace(/-/g, '')}T${time.replace(/:/g, '').slice(0, 6)}`;
}

function escapeICS(str) {
  return String(str || '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\n/g, '\\n');
}

function foldICSLine(line) {
  if (line.length <= 75) return line;
  const parts = [];
  let start = 0;
  while (start < line.length) {
    const len = start === 0 ? 75 : 74;
    parts.push((start === 0 ? '' : ' ') + line.slice(start, start + len));
    start += len;
  }
  return parts.join('\r\n');
}

function buildICS(record) {
  const now = new Date().toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
  const dtStart = toICSDateTime(record.date, record.start_time);
  const dtEnd = toICSDateTime(record.date, record.end_time);
  const uid = `${record.id}@charlesdigital.deals`;

  const descriptionRaw = [
    `Email: ${record.client_email || ''}`,
    record.client_phone ? `Phone: ${record.client_phone}` : null,
    record.notes ? `Notes: ${record.notes}` : null,
  ]
    .filter(Boolean)
    .join('\n');

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Charles Digital//Booking//EN',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${now}`,
    `DTSTART;TZID=${TIMEZONE}:${dtStart}`,
    `DTEND;TZID=${TIMEZONE}:${dtEnd}`,
    `SUMMARY:${escapeICS('Charles Digital call — ' + (record.client_name || 'Client'))}`,
    `DESCRIPTION:${escapeICS(descriptionRaw)}`,
    'END:VEVENT',
    'END:VCALENDAR',
  ];

  return lines.map(foldICSLine).join('\r\n');
}
