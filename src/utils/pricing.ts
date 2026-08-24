/**
 * El negocio cotiza al cliente el precio redondeado hacia arriba, al dólar
 * entero más próximo -- $5.50 y $5.20 se muestran como $6.00. El precio
 * real en products.price NUNCA se toca; esto es solo para lo que ve el
 * cliente en la respuesta de WhatsApp.
 */
export function roundedCustomerPrice(price: number): number {
  return Math.ceil(price)
}
