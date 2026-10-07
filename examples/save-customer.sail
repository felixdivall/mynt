scheduled {
    let customer = load Customer("123")

    customer.comments = "Updated by Sail"

    save customer
}
