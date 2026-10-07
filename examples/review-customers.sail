scheduled {
    let customers = query Customer
        where email != ""

    for customer in customers {
        let record = load Customer(customer.id)

        if record.comments == "" {
            record.comments = "Reviewed by Sail"
            save record
        }
    }
}
