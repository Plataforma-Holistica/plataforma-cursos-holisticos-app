-- T-303, segunda solicitud · Recibir los avisos de Stripe. Lo único de la base: `charge.updated` deja de ser un tipo que se aplica (decisión mía sin confirmar, después
-- de la revisión del diff del 2026-11-07). Llega también por cargos fallidos o anteriores del mismo PaymentIntent, que no son un cobro de la factura, y como tipo de cobro
-- no se podía ignorar: quedaba fallido y frenaba el cierre. El punto de conexión no se suscribe a él; si llega, se ignora. Lo que liquida Stripe de un cobro cuya
-- transacción de saldo no llegó con su factura lo completa la conciliación (la cuarta solicitud de T-303).

create or replace function private.billing_event_kind(p_type text) returns text
language sql immutable set search_path = ''
as $$
  select case
    when p_type in ('invoice.paid', 'invoice.payment_failed', 'customer.subscription.created', 'customer.subscription.updated',
                    'customer.subscription.deleted') then 'apply'
    when p_type = 'charge.refunded' or p_type like 'charge.dispute.%' then 'defer'
  end
$$;
