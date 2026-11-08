-- Pagos desactivados hasta tener la cuenta real de Paddle (RUC pendiente).
-- Ningún precio de Paddle da un plan: un pago con tarjeta de prueba del Sandbox,
-- aunque se abra a mano desde la consola del navegador, deja al usuario en Gratis.
-- Para reactivar: insertar los precios de producción en public.paddle_prices.
delete from public.paddle_prices;

-- Quien tenga un plan obtenido con pagos de prueba vuelve a Gratis (sus monitores de más, en pausa)
update public.subscriptions set plan = 'free' where plan <> 'free';
update public.profiles set plan = 'free' where plan <> 'free';
select public.fit_monitors_to_plan(id) from public.profiles;
