scheduled {
    let order = create SalesOrder

    add order.item {
        item = "100"
        quantity = 2
        rate = 10
    }

    add order.item {
        item = "200"
        quantity = 1
        rate = 25
    }

    save order
}
