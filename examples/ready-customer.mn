scheduled {
    let customer = load Customer("123")

    if customer.email != "" && (customer.comments == "" || customer.comments == "New") {
        customer.comments = "Ready"
        save customer
    }
}
