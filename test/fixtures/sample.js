function calculateTotal(items) {
  return items.reduce((sum, item) => sum + item.price * item.quantity, 0);
}

const applyDiscount = (total, discountPercent) => {
  return total * (1 - discountPercent / 100);
};

class ShoppingCart {
  constructor() {
    this.items = [];
  }

  addItem(item) {
    this.items.push(item);
  }

  getTotal() {
    return calculateTotal(this.items);
  }

  checkout(discountPercent = 0) {
    const total = this.getTotal();
    return applyDiscount(total, discountPercent);
  }
}

module.exports = { calculateTotal, applyDiscount, ShoppingCart };
