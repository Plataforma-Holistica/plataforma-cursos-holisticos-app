-- T-104 · El servidor puede bajar al rol de la persona (ADR-31, TRD §8.10).
-- Esquema de backend §17.3: la credencial de la aplicación recibe authenticated y anon.

-- app_service salta la seguridad por fila. Para leer por una persona, el adaptador cambia
-- de rol dentro de la transacción (`set local role authenticated`) y la base filtra.
--
-- Sin herencia: app_service puede cambiar a esos roles, pero no recibe sus permisos. Lo
-- que puede hacer con su propio rol sigue siendo lo que cada migración le concede a mano.
grant authenticated, anon to app_service with inherit false, set true;
