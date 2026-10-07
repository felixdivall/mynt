scheduled {
    let customer = load Customer("123")

    if customer.email == "" || customer.comments == "Blocked" {
        customer.comments = "Needs review"
        save customer
    }
}
