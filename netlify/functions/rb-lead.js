const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in env');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

function generateLeadId() {
  const num = Math.floor(Math.random() * 90000) + 10000;
  return `RB${num}`;
}

function mapPayloadToRecord(payload, meta) {
  return {
    lead_id: String(payload.leadId || generateLeadId()),
    full_name: String(payload.fullName || '').trim(),
    primary_phone: String(payload.primaryPhone || '').trim(),
    email: String(payload.email || '').trim(),
    preferred_channel: String(payload.preferredChannel || '').trim(),
    hear_about_us: Array.isArray(payload.hearAboutUs) ? payload.hearAboutUs.join(', ') : String(payload.hearAboutUs || '').trim(),
    parish: String(payload.parish || '').trim(),
    community: String(payload.community || '').trim(),
    property_status: String(payload.propertyStatus || '').trim(),
    rebuild_type: String(payload.rebuildType || '').trim(),
    hurricane_impact_level: payload.hurricaneImpactLevel ? Number(payload.hurricaneImpactLevel) : null,
    project_priority: payload.projectPriority ? Number(payload.projectPriority) : null,
    estimated_budget: String(payload.estimatedBudget || '').trim(),
    monthly_payment: String(payload.monthlyPayment || payload.comfortableMonthly || '').trim(),
    start_timeline_months: payload.startTimelineMonths ? Number(payload.startTimelineMonths) : (payload.desiredTimelineMonths ? Number(payload.desiredTimelineMonths) : null),
    nht_contributor: String(payload.nhtContributor || '').trim(),
    employment_type: String(payload.employmentType || '').trim(),
    nht_product: String(payload.nhtProduct || '').trim(),
    other_financing: String(payload.otherFinancing || '').trim(),
    income_range: String(payload.incomeRange || '').trim(),
    overseas_sponsor: (payload.overseasSponsor === true || payload.overseasSponsor === "true") ? true : false,
    sponsor_country: String(payload.sponsorCountry || '').trim(),
    willing_visit: String(payload.willingVisit || '').trim(),
    visit_window: String(payload.visitWindow || '').trim(),
    source_page: meta.source_page || null,
    user_agent: meta.user_agent || null,
    ip: meta.ip || null,
  };
}

exports.handler = async function (event, context) {
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: false, error: 'Method not allowed' }),
    };
  }

  let payload = {};
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (err) {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: false, error: 'Invalid JSON payload' }),
    };
  }

  const required = [
    { key: 'fullName', label: 'Full name' },
    { key: 'primaryPhone', label: 'Primary phone' },
    { key: 'preferredChannel', label: 'Preferred channel' },
    { key: 'parish', label: 'Parish' },
    { key: 'rebuildType', label: 'Rebuild type' },
    { key: 'estimatedBudget', label: 'Estimated budget' },
    { key: 'monthlyPayment', label: 'Monthly payment' },
  ];

  const missing = required.filter(r => {
    const v = payload[r.key];
    return v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
  });

  if (missing.length > 0) {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        success: false,
        error: `Missing required fields: ${missing.map(m => m.label).join(', ')}`,
      }),
    };
  }

  const headers = event.headers || {};
  const ip = headers['x-nf-client-connection-ip'] || headers['x-forwarded-for'] || null;
  const user_agent = headers['user-agent'] || null;
  const source_page = payload.source_page || headers.referer || headers.referrer || null;

  const meta = { ip, user_agent, source_page };

  const record = mapPayloadToRecord(payload, meta);

  try {
    const { data, error } = await supabase
      .from('rb_leads')
      .insert(record)
      .select('lead_id')
      .single();

    if (error) {
      console.error('Supabase insert error:', error);
      return {
        statusCode: 500,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ success: false, error: 'Failed to write lead to database.' }),
      };
    }

    const leadId = (data && data.lead_id) ? data.lead_id : record.lead_id;

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: true, leadId }),
    };
  } catch (err) {
    console.error('Unexpected error inserting lead:', err);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: false, error: 'Unexpected server error' }),
    };
  }
};
