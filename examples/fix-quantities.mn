scheduled {
    let orders = query SalesOrder

    for row in orders {
        let order = load SalesOrder(row.id)

        for line in order.item {
            if line.quantity < 1 {
                line.quantity = 1
            }
        }

        save order
    }
}
